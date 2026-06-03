import { resolve } from "node:path";
import { HttpError } from "./http.mjs";
import { SessionManager } from "./pi-runtime.mjs";

export function sessionInfoPayload(s) {
  return {
    path: s.path,
    id: s.id,
    cwd: s.cwd,
    name: s.name,
    created: s.created,
    modified: s.modified,
    messageCount: s.messageCount,
    firstMessage: s.firstMessage,
  };
}

export async function listCurrentSessions(runtime) {
  return (await SessionManager.list(runtime.cwd)).map(sessionInfoPayload);
}

export async function listAllSessions() {
  return (await SessionManager.listAll()).map(sessionInfoPayload);
}

export async function listCwds() {
  const latestByCwd = new Map();
  for (const session of await SessionManager.listAll()) {
    if (!session.cwd) continue;
    const prev = latestByCwd.get(session.cwd);
    if (!prev || session.modified > prev) latestByCwd.set(session.cwd, session.modified);
  }
  return [...latestByCwd.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cwd]) => cwd);
}

export function assertSessionName(value) {
  if (typeof value !== "string") throw new HttpError(400, "Missing name");
  if (value.length > 160) throw new HttpError(400, "Session name is too long");
  return value;
}

export async function assertKnownSessionPath(value) {
  if (typeof value !== "string" || !value.endsWith(".jsonl")) throw new HttpError(400, "Missing session path");
  const target = resolve(value);
  const sessions = await SessionManager.listAll();
  const match = sessions.find((s) => resolve(s.path) === target);
  if (!match) throw new HttpError(403, "Unknown session path");
  return match.path;
}

export function renameSession(path, name, runtime) {
  if (resolve(path) === resolve(runtime.session.sessionFile ?? "")) {
    runtime.session.sessionManager.appendSessionInfo(name);
  } else {
    SessionManager.open(path).appendSessionInfo(name);
  }
}
