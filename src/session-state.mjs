import { resolve } from "node:path";
import { HttpError } from "./http.mjs";
import { SessionManager } from "./pi-runtime.mjs";

export function textOfContent(content) {
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

export function sessionPayload(runtime) {
  const session = runtime.session;
  const sm = session.sessionManager;
  const activeBranch = sm.getBranch();
  const activeEntries = activeBranch.filter((entry) => entry.type === "message" && entry.message);
  const activeIds = new Set(activeBranch.map((entry) => entry.id));
  const toMessage = (entry, stale = false) => ({
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

  const timeline = [];
  const roots = sm.getTree();
  const stack = [...roots].reverse();
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    const entry = node?.entry;
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (entry.type === "message") timeline.push(toMessage(entry, !activeIds.has(entry.id)));
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }

  return {
    cwd: runtime.cwd,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    isStreaming: session.isStreaming,
    messages: activeEntries.map((entry) => toMessage(entry)),
    timeline,
  };
}

export async function listSessions(scope, runtime) {
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

export async function assertKnownSessionPath(value) {
  if (typeof value !== "string" || !value.endsWith(".jsonl")) throw new HttpError(400, "Missing session path");
  const target = resolve(value);
  const sessions = await SessionManager.listAll();
  const match = sessions.find((s) => resolve(s.path) === target);
  if (!match) throw new HttpError(403, "Unknown session path");
  return match.path;
}
