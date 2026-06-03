import { createServer } from "node:http";
import { promises as fs, statSync } from "node:fs";
import { resolve } from "node:path";
import { host, port, publicDir } from "./config.mjs";
import { HttpError, readBody, sendError, sendJson, writeNdjson } from "./http.mjs";
import { makeRuntime, SessionManager } from "./pi-runtime.mjs";
import { assertKnownSessionPath, listSessions, sessionPayload } from "./session-state.mjs";
import { serveStatic } from "./static.mjs";
import { subscribePromptEvents } from "./stream-events.mjs";

let cwd = process.cwd();
let runtime = await makeRuntime(cwd, SessionManager.continueRecent(cwd));
let operationState = "idle";
let activePrompt = null;

function isSafeEntryId(entryId) {
  return /^[A-Za-z0-9_-]+$/.test(entryId);
}

function assertDirectory(value) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "Invalid working directory");
  const dir = resolve(value);
  try {
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (!stat) throw new HttpError(404, "Directory not found");
    if (!stat.isDirectory()) throw new HttpError(400, "Not a directory");
    return dir;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "Cannot access working directory");
  }
}

function assertEntryId(value) {
  if (typeof value !== "string") throw new HttpError(400, "Missing entryId");
  if (!isSafeEntryId(value)) throw new HttpError(400, "Invalid entryId format");
  return value;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function currentState() {
  return sessionPayload(runtime);
}

function promptIsActive() {
  return operationState === "prompt" || runtime.session.isStreaming;
}

async function waitUntilNotStreaming(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!promptIsActive()) return true;
    await sleep(100);
  }
  return !promptIsActive();
}

async function ensureNotStreamingForMutation() {
  if (!promptIsActive()) return;
  if (!activePrompt?.clientClosed) throw new HttpError(409, "Cannot change sessions while a response is streaming");

  await activePrompt.session.abort().catch(() => {});
  if (await waitUntilNotStreaming(1_500)) return;

  const oldRuntime = runtime;
  operationState = "idle";
  activePrompt = null;
  await oldRuntime.dispose().catch(() => {});
  runtime = await makeRuntime(cwd, SessionManager.continueRecent(cwd));
}

async function withRuntimeMutation(fn) {
  await ensureNotStreamingForMutation();
  if (operationState !== "idle") throw new HttpError(409, "Another session operation is in progress");
  operationState = "mutation";
  try {
    await ensureNotStreamingForMutation();
    return await fn();
  } finally {
    operationState = "idle";
  }
}

const apiRoutes = new Map([
  ["GET /api/state", async (_req, res, _url) => sendJson(res, currentState())],
  ["GET /api/sessions", async (_req, res, url) => sendJson(res, await listSessions(url.searchParams.get("scope") ?? "current", runtime))],
  ["POST /api/cwd", async (req, res, _url) => {
    const { cwd: next } = await readBody(req);
    const nextCwd = assertDirectory(next);
    await withRuntimeMutation(async () => {
      await runtime.dispose();
      cwd = nextCwd;
      runtime = await makeRuntime(cwd, SessionManager.continueRecent(cwd));
    });
    sendJson(res, currentState());
  }],
  ["POST /api/sessions/new", async (_req, res, _url) => {
    await withRuntimeMutation(() => runtime.newSession());
    sendJson(res, currentState());
  }],
  ["POST /api/sessions/open", async (req, res, _url) => {
    const { path: value } = await readBody(req);
    const path = await assertKnownSessionPath(value);
    await withRuntimeMutation(async () => {
      await runtime.switchSession(path);
      cwd = runtime.cwd;
    });
    sendJson(res, currentState());
  }],
  ["DELETE /api/sessions", async (_req, res, url) => {
    const path = await assertKnownSessionPath(url.searchParams.get("path"));
    await withRuntimeMutation(async () => {
      if (resolve(path) === resolve(runtime.session.sessionFile ?? "")) await runtime.newSession();
      await fs.rm(path, { force: true });
    });
    sendJson(res, { ok: true, state: currentState() });
  }],
  ["POST /api/rewind", async (req, res, _url) => {
    const { entryId: value } = await readBody(req);
    await withRuntimeMutation(() => runtime.session.navigateTree(assertEntryId(value), { summarize: false, label: "rewind" }));
    sendJson(res, currentState());
  }],
  ["POST /api/fork", async (req, res, _url) => {
    const { entryId: value } = await readBody(req);
    const result = await withRuntimeMutation(() => runtime.fork(assertEntryId(value)));
    sendJson(res, { ...currentState(), fork: result });
  }],
]);

function clearActivePrompt(activeSession) {
  if (activePrompt?.session === activeSession) activePrompt = null;
  operationState = "idle";
}

async function readPromptText(req, activeSession) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    clearActivePrompt(activeSession);
    throw error;
  }

  if (typeof body.text !== "string" || !body.text.trim()) {
    clearActivePrompt(activeSession);
    throw new HttpError(400, "Message is empty");
  }
  return body.text;
}

async function handlePrompt(req, res) {
  if (operationState === "mutation") throw new HttpError(409, "Another session operation is in progress");
  if (promptIsActive()) throw new HttpError(409, "A response is already streaming");

  operationState = "prompt";
  const activeRuntime = runtime;
  const activeSession = activeRuntime.session;
  activePrompt = { session: activeSession, clientClosed: false };

  const text = await readPromptText(req, activeSession);
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  let completed = false;
  const heartbeat = setInterval(() => writeNdjson(res, { type: "ping", timestamp: Date.now() }), 10_000);
  req.on("close", () => {
    if (activePrompt?.session === activeSession) activePrompt.clientClosed = true;
    if (!completed) void activeSession.abort().catch(() => {});
  });

  const unsubscribe = subscribePromptEvents(activeSession, res, () => sessionPayload(activeRuntime));
  try {
    writeNdjson(res, { type: "accepted" });
    await activeSession.prompt(text);
    writeNdjson(res, { type: "done", state: sessionPayload(activeRuntime) });
  } catch (error) {
    writeNdjson(res, { type: "error", message: error instanceof Error ? error.message : String(error), state: sessionPayload(activeRuntime) });
  } finally {
    completed = true;
    clearActivePrompt(activeSession);
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  }
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/prompt") {
      await handlePrompt(req, res);
      return;
    }

    const handler = apiRoutes.get(`${req.method} ${url.pathname}`);
    if (handler) {
      await handler(req, res, url);
      if (!res.writableEnded) sendJson(res, currentState());
      return;
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendError(res, error);
  }
}

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    sendJson(res, { error: "Bad request" }, 400);
    return;
  }

  if (url.pathname.startsWith("/api/")) void handleApi(req, res, url);
  else serveStatic(req, res, url.pathname, publicDir);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: shutting down...`);
  server.close();
  await runtime.dispose().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(port, host, () => {
  console.log(`pi-web listening at http://${host}:${port}`);
  console.log(`cwd: ${cwd}`);
});
