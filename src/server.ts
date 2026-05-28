import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, promises as fs, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(rootDir, "public");
const port = Number(process.env.PORT ?? 8787);
let cwd = process.cwd();

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

async function makeRuntime(nextCwd: string, sessionManager = SessionManager.create(nextCwd)) {
  return createAgentSessionRuntime(createRuntime, {
    cwd: nextCwd,
    agentDir: getAgentDir(),
    sessionManager,
  });
}

let runtime = await makeRuntime(cwd, SessionManager.continueRecent(cwd));

type Json = Record<string, unknown>;
const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type SessionEntry = {
  id: string;
  parentId?: string | null;
  timestamp?: number;
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    errorMessage?: string;
    stopReason?: string;
    toolName?: string;
    isError?: boolean;
  };
};

type SessionTreeNode = {
  entry?: SessionEntry;
  children: SessionTreeNode[];
};

type RuntimeSessionManager = {
  getBranch(): SessionEntry[];
  getTree(): SessionTreeNode[];
};

type RuntimeSession = {
  sessionId: typeof runtime.session.sessionId;
  sessionFile: typeof runtime.session.sessionFile;
  isStreaming: typeof runtime.session.isStreaming;
  sessionManager: RuntimeSessionManager;
};

function isSafeEntryId(entryId: string) {
  return /^[A-Za-z0-9_-]+$/.test(entryId);
}

function isInside(base: string, target: string) {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sendJson(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function sendError(res: ServerResponse, error: unknown, status = 500) {
  const httpStatus = error instanceof HttpError ? error.status : status;
  sendJson(res, { error: error instanceof Error ? error.message : String(error) }, httpStatus);
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Body must be a JSON object");
    return parsed as Json;
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid JSON");
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      if (part && typeof part === "object" && "thinking" in part && typeof part.thinking === "string") return part.thinking;
      if (part && typeof part === "object" && "name" in part && typeof part.name === "string") return `[tool: ${part.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function sessionPayload(targetRuntime = runtime) {
  const session = targetRuntime.session as unknown as RuntimeSession;
  const sm = session.sessionManager;
  const activeBranch = sm.getBranch();
  const activeEntries = activeBranch.filter((entry) => entry.type === "message" && entry.message);
  const activeIds = new Set(activeBranch.map((entry) => entry.id));
  const toMessage = (entry: SessionEntry, stale = false) => ({
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    role: entry.message?.role ?? "assistant",
    text: textOfContent(entry.message?.content),
    error: entry.message?.errorMessage,
    stopReason: entry.message?.stopReason,
    toolName: entry.message?.toolName,
    isError: entry.message?.isError,
    stale,
  });

  const timeline: ReturnType<typeof toMessage>[] = [];
  // Match Pi /tree: use SessionManager.getTree() as-is, including orphan roots.
  // Forked sessions can legitimately start at an entry whose original parent is
  // outside the extracted path; filtering to parentId === null would hide that
  // retained history in the web UI even though Pi's tree selector shows it.
  const roots = sm.getTree();
  const stack = [...roots].reverse();
  const seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop();
    const entry = node?.entry;
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (entry.type === "message") timeline.push(toMessage(entry, !activeIds.has(entry.id)));
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }

  return {
    cwd: targetRuntime.cwd,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    isStreaming: session.isStreaming,
    messages: activeEntries.map((entry) => toMessage(entry)),
    timeline,
  };
}

async function listSessions(scope: string) {
  const list = scope === "all" ? await SessionManager.listAll() : await SessionManager.list(runtime.cwd);
  return list.map((s) => ({
    path: s.path,
    id: s.id,
    cwd: s.cwd,
    name: s.name,
    created: s.created,
    modified: s.modified,
    messageCount: s.messageCount,
    firstMessage: s.firstMessage,
  }));
}

function writeNdjson(res: ServerResponse, obj: unknown) {
  if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(obj)}\n`);
}

function shortText(value: unknown, max = 160) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolMessage(phase: "queued" | "running" | "update" | "done", toolName: string, details?: unknown) {
  const icon = phase === "done" ? "✓" : phase === "queued" ? "…" : "▶";
  const suffix = details === undefined ? "" : ` ${shortText(details)}`;
  const label = phase === "done" ? "done" : phase === "queued" ? "queued" : "running";
  return `${icon} ${toolName} ${label}${suffix}`;
}

function assertDirectory(value: unknown): string {
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

function assertEntryId(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Missing entryId");
  if (!isSafeEntryId(value)) throw new HttpError(400, "Invalid entryId format");
  return value;
}

function assertNotStreaming() {
  if (promptInFlight || runtime.session.isStreaming) throw new HttpError(409, "Cannot change sessions while a response is streaming");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let mutatingRuntime = false;
let promptInFlight = false;
let activePrompt: { runtime: typeof runtime; session: typeof runtime.session; clientClosed: boolean } | null = null;

async function waitUntilNotStreaming(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!promptInFlight && !runtime.session.isStreaming) return true;
    await sleep(100);
  }
  return !promptInFlight && !runtime.session.isStreaming;
}

async function ensureNotStreamingForMutation() {
  if (!promptInFlight && !runtime.session.isStreaming) return;
  if (!activePrompt?.clientClosed) throw new HttpError(409, "Cannot change sessions while a response is streaming");

  await activePrompt.session.abort().catch(() => {});
  if (await waitUntilNotStreaming(1_500)) return;

  // The browser has gone away and Pi still reports streaming. Treat it as a
  // stuck prompt and rebuild the runtime so session operations are not blocked
  // forever by the orphaned stream.
  const oldRuntime = runtime;
  promptInFlight = false;
  activePrompt = null;
  await oldRuntime.dispose().catch(() => {});
  runtime = await makeRuntime(cwd, SessionManager.continueRecent(cwd));
}

async function withRuntimeMutation<T>(fn: () => Promise<T>): Promise<T> {
  await ensureNotStreamingForMutation();
  if (mutatingRuntime) throw new HttpError(409, "Another session operation is in progress");
  mutatingRuntime = true;
  try {
    await ensureNotStreamingForMutation();
    return await fn();
  } finally {
    mutatingRuntime = false;
  }
}

async function assertKnownSessionPath(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.endsWith(".jsonl")) throw new HttpError(400, "Missing session path");
  const target = resolve(value);
  const sessions = await SessionManager.listAll();
  const match = sessions.find((s) => resolve(s.path) === target);
  if (!match) throw new HttpError(403, "Unknown session path");
  return match.path;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

const apiRoutes: Map<string, RouteHandler> = new Map([
  ["GET /api/state", (_, res, _url) => sendJson(res, sessionPayload())],
  ["GET /api/sessions", async (_, res, url) => sendJson(res, await listSessions(url.searchParams.get("scope") ?? "current"))],
  ["POST /api/cwd", async (req, res, _url) => {
    const { cwd: next } = await readBody(req);
    const nextCwd = assertDirectory(next);
    await withRuntimeMutation(async () => {
      await runtime.dispose();
      cwd = nextCwd;
      runtime = await makeRuntime(cwd, SessionManager.continueRecent(cwd));
    });
    sendJson(res, sessionPayload());
  }],
  ["POST /api/sessions/new", async (_req, res, _url) => {
    await withRuntimeMutation(() => runtime.newSession());
    sendJson(res, sessionPayload());
  }],
  ["POST /api/sessions/open", async (req, res, _url) => {
    const { path: value } = await readBody(req);
    const path = await assertKnownSessionPath(value);
    await withRuntimeMutation(async () => {
      await runtime.switchSession(path);
      cwd = runtime.cwd;
    });
    sendJson(res, sessionPayload());
  }],
  ["DELETE /api/sessions", async (_req, res, url) => {
    const path = await assertKnownSessionPath(url.searchParams.get("path"));
    await withRuntimeMutation(async () => {
      if (resolve(path) === resolve(runtime.session.sessionFile ?? "")) await runtime.newSession();
      await fs.rm(path, { force: true });
    });
    sendJson(res, { ok: true, state: sessionPayload() });
  }],
  ["POST /api/rewind", async (req, res, _url) => {
    const { entryId: value } = await readBody(req);
    const entryId = assertEntryId(value);
    await withRuntimeMutation(() => runtime.session.navigateTree(entryId, { summarize: false, label: "rewind" }));
    sendJson(res, sessionPayload());
  }],
  ["POST /api/fork", async (req, res, _url) => {
    const { entryId: value } = await readBody(req);
    const entryId = assertEntryId(value);
    const result = await withRuntimeMutation(() => runtime.fork(entryId));
    sendJson(res, { ...sessionPayload(), fork: result });
  }],
]);

async function handlePrompt(req: IncomingMessage, res: ServerResponse) {
  if (mutatingRuntime) throw new HttpError(409, "Another session operation is in progress");
  if (promptInFlight || runtime.session.isStreaming) throw new HttpError(409, "A response is already streaming");
  promptInFlight = true;
  const activeRuntime = runtime;
  const activeSession = activeRuntime.session;
  activePrompt = { runtime: activeRuntime, session: activeSession, clientClosed: false };
  let body: Json;
  try {
    body = await readBody(req);
  } catch (error) {
    promptInFlight = false;
    throw error;
  }
  const { text } = body;
  if (typeof text !== "string" || !text.trim()) {
    promptInFlight = false;
    throw new HttpError(400, "Message is empty");
  }
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
  const unsubscribe = activeSession.subscribe((event: any) => {
    if (event.type === "message_start") writeNdjson(res, { type: "message_start" });
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta") writeNdjson(res, { type: "delta", delta: update.delta });
      if (update?.type === "thinking_delta") writeNdjson(res, { type: "delta", delta: update.delta ?? update.thinking });
      if (update?.type === "toolcall_start") writeNdjson(res, { type: "tool", phase: "queued", message: "… preparing tool call" });
      if (update?.type === "toolcall_end") writeNdjson(res, { type: "tool", phase: "queued", toolName: update.toolCall.name, message: toolMessage("queued", update.toolCall.name, update.toolCall.arguments) });
    }
    if (event.type === "tool_execution_start") writeNdjson(res, { type: "tool", phase: "running", toolName: event.toolName, message: toolMessage("running", event.toolName, event.args) });
    if (event.type === "tool_execution_update") writeNdjson(res, { type: "tool", phase: "update", toolName: event.toolName, message: toolMessage("update", event.toolName, textOfContent(event.partialResult?.content)) });
    if (event.type === "tool_execution_end") writeNdjson(res, { type: "tool", phase: "done", toolName: event.toolName, message: toolMessage("done", event.toolName, event.isError ? "error" : textOfContent(event.result?.content)) });
    if (event.type === "agent_end") writeNdjson(res, { type: "state", state: sessionPayload(activeRuntime) });
  });
  try {
    writeNdjson(res, { type: "accepted" });
    await activeSession.prompt(text);
    writeNdjson(res, { type: "done", state: sessionPayload(activeRuntime) });
  } catch (error) {
    writeNdjson(res, { type: "error", message: error instanceof Error ? error.message : String(error), state: sessionPayload(activeRuntime) });
  } finally {
    completed = true;
    if (activePrompt?.session === activeSession) activePrompt = null;
    promptInFlight = false;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    if (req.method === "POST" && url.pathname === "/api/prompt") {
      await handlePrompt(req, res);
      return;
    }
    const routeKey = `${req.method} ${url.pathname}`;
    const handler = apiRoutes.get(routeKey);
    if (handler) {
      await handler(req, res, url);
      if (!res.writableEnded) sendJson(res, sessionPayload());
      return;
    }
    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendError(res, error);
  }
}

function serveStatic(res: ServerResponse, pathname: string) {
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  let requested: string;
  try {
    requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  let filePath = resolve(publicDir, `.${requested}`);
  if (!isInside(publicDir, filePath)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  // Browser refreshes/deep links should still show the app instead of JSON 404.
  try {
    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) filePath = join(publicDir, "index.html");
  } catch {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  const type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
  createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/")) void handleApi(req, res, url);
  else serveStatic(res, url.pathname);
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: shutting down...`);
  server.close();
  await runtime.dispose().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(port, () => {
  console.log(`pi-web listening at http://localhost:${port}`);
  console.log(`cwd: ${cwd}`);
});
