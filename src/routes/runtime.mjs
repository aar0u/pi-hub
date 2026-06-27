import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readCodexUsage } from "../codex-usage.mjs";
import { HttpError, readBody, sendJson } from "../http.mjs";
import { makeRuntime, SessionManager } from "../pi-runtime.mjs";
import { listCwds } from "../sessions-api.mjs";

function isSafeEntryId(entryId) {
  return /^[A-Za-z0-9_-]+$/.test(entryId);
}

function normalizePathForCompare(value) {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function cwdIsKnown(value, currentCwd) {
  const requested = normalizePathForCompare(value);
  return (await listCwds([currentCwd])).some((cwd) => normalizePathForCompare(cwd) === requested);
}

function assertCwdValue(value) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "Invalid working directory");
  return value;
}

function assertDirectory(value, { allowCreate = true } = {}) {
  assertCwdValue(value);
  const dir = resolve(value);
  try {
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (!stat) {
      if (!allowCreate) throw new HttpError(400, "Working directory does not exist");
      mkdirSync(dir, { recursive: true });
      return { dir, created: true };
    }
    if (!stat.isDirectory()) throw new HttpError(400, "Not a directory");
    return { dir, created: false };
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

function slashCommandPayload(command) {
  return {
    name: command.name,
    description: command.description,
    source: command.source,
    sourceInfo: command.sourceInfo,
  };
}

function listSlashCommands(runtime) {
  const session = runtime.session;
  const commands = [];
  for (const command of session.extensionRunner?.getRegisteredCommands?.() ?? []) {
    commands.push(slashCommandPayload({
      name: command.invocationName,
      description: command.description,
      source: "extension",
      sourceInfo: command.sourceInfo,
    }));
  }
  for (const template of session.promptTemplates ?? []) {
    commands.push(slashCommandPayload({
      name: template.name,
      description: template.description,
      source: "prompt",
      sourceInfo: template.sourceInfo,
    }));
  }
  for (const skill of session.resourceLoader?.getSkills?.().skills ?? []) {
    commands.push(slashCommandPayload({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
      sourceInfo: skill.sourceInfo,
    }));
  }
  return commands;
}

export function registerRuntimeRoutes(apiRoutes, context) {
  apiRoutes.set("GET /api/state", async (_req, res, _url) => {
    sendJson(res, context.currentState());
  });

  apiRoutes.set("GET /api/commands", async (_req, res, _url) => {
    sendJson(res, listSlashCommands(context.getRuntime()));
  });

  apiRoutes.set("GET /api/codex-usage", async (_req, res, _url) => {
    sendJson(res, await readCodexUsage());
  });

  apiRoutes.set("POST /api/cwd", async (req, res, _url) => {
    const { cwd: next } = await readBody(req);
    assertCwdValue(next);
    const { dir: nextCwd, created } = assertDirectory(next, { allowCreate: await cwdIsKnown(next, context.getRuntime().cwd) });
    await context.withRuntimeMutation(async () => {
      await context.getRuntime().dispose();
      context.setCwd(nextCwd);
      context.setRuntime(await makeRuntime(nextCwd, SessionManager.continueRecent(nextCwd)));
    });
    sendJson(res, { ...context.currentState(), cwdCreated: created });
  });

  apiRoutes.set("POST /api/navigate-tree", async (req, res, _url) => {
    const { entryId: value } = await readBody(req);
    const navigation = await context.withRuntimeMutation(() => context.getRuntime().session.navigateTree(assertEntryId(value), { summarize: false }));
    sendJson(res, { ...context.currentState(), navigation });
  });

  apiRoutes.set("POST /api/fork", async (req, res, _url) => {
    const { entryId: value } = await readBody(req);
    const result = await context.withRuntimeMutation(() => context.getRuntime().fork(assertEntryId(value), { position: "at" }));
    sendJson(res, { ...context.currentState(), fork: result });
  });
}
