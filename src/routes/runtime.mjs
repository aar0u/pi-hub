import { statSync } from "node:fs";
import { resolve } from "node:path";
import { HttpError, readBody, sendJson } from "../http.mjs";
import { makeRuntime, SessionManager } from "../pi-runtime.mjs";

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

export function registerRuntimeRoutes(apiRoutes, context) {
  apiRoutes.set("GET /api/state", async (_req, res, _url) => {
    sendJson(res, context.currentState());
  });

  apiRoutes.set("POST /api/cwd", async (req, res, _url) => {
    const { cwd: next } = await readBody(req);
    const nextCwd = assertDirectory(next);
    await context.withRuntimeMutation(async () => {
      await context.getRuntime().dispose();
      context.setCwd(nextCwd);
      context.setRuntime(await makeRuntime(nextCwd, SessionManager.continueRecent(nextCwd)));
    });
    sendJson(res, context.currentState());
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
