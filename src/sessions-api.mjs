import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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

function normalizeCwd(cwd) {
  return resolve(cwd);
}

async function statDir(path) {
  try {
    const info = await stat(path);
    return info.isDirectory() ? info : null;
  } catch {
    return null;
  }
}

async function resolveEncodedPathParts(root, encoded) {
  if (!encoded) return root;
  const tokens = encoded.split("-").filter(Boolean);

  async function find(index, current) {
    if (index >= tokens.length) return current;
    for (let end = index + 1; end <= tokens.length; end++) {
      const candidate = join(current, tokens.slice(index, end).join("-"));
      if (!(await statDir(candidate))) continue;
      const resolved = await find(end, candidate);
      if (resolved) return resolved;
    }
    return null;
  }

  return find(0, root);
}

async function inferCwdFromSessionDirName(name) {
  if (!name.startsWith("--") || !name.endsWith("--")) return null;
  const encoded = name.slice(2, -2);
  const windowsDrive = encoded.match(/^([A-Za-z])--(.*)$/);
  if (windowsDrive) return resolveEncodedPathParts(`${windowsDrive[1]}:\\`, windowsDrive[2]);
  return resolveEncodedPathParts(resolve("/"), encoded);
}

async function addSessionDirCwds(latestByCwd) {
  const sessionsDir = join(getAgentDir(), "sessions");
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cwd = await inferCwdFromSessionDirName(entry.name);
    if (!cwd) continue;
    const normalized = normalizeCwd(cwd);
    if (latestByCwd.has(normalized)) continue;
    const info = await statDir(join(sessionsDir, entry.name));
    latestByCwd.set(normalized, info?.mtime ?? new Date(0));
  }
}

export async function listCwds(extraCwds = []) {
  const latestByCwd = new Map();
  for (const session of await SessionManager.listAll()) {
    if (!session.cwd) continue;
    const cwd = normalizeCwd(session.cwd);
    const prev = latestByCwd.get(cwd);
    if (!prev || session.modified > prev) latestByCwd.set(cwd, session.modified);
  }
  for (const cwd of extraCwds) {
    const normalized = cwd ? normalizeCwd(cwd) : "";
    if (normalized && !latestByCwd.has(normalized)) latestByCwd.set(normalized, new Date());
  }
  await addSessionDirCwds(latestByCwd);
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
