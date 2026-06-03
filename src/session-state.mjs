function shortJson(value) {
  if (value === undefined) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolPartText(part) {
  const details = shortJson(part.input ?? part.arguments ?? part.args);
  return details ? `[tool: ${part.name}] ${details}` : `[tool: ${part.name}]`;
}

export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      if (part && typeof part === "object" && "thinking" in part && typeof part.thinking === "string") return part.thinking;
      if (part && typeof part === "object" && "name" in part && typeof part.name === "string") return toolPartText(part);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function systemPromptOf(session) {
  const state = session.agent?.state ?? session.state;
  return state && "systemPrompt" in state ? (state.systemPrompt ?? "") : null;
}

function treeDisplayText(entry) {
  if (entry.type !== "message" || !entry.message) return entry.type || "entry";
  const role = entry.message.role || "assistant";
  const text = textOfContent(entry.message.content) || entry.message.errorMessage || entry.message.toolName || "";
  return `${role}: ${text}`.replace(/\s+/g, " ").trim();
}

function treeItems(roots, activeLeafId, activeIds) {
  const containsActive = new Map();
  const allNodes = [];
  const preOrder = [...roots].reverse();
  while (preOrder.length) {
    const node = preOrder.pop();
    allNodes.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) preOrder.push(node.children[i]);
  }
  for (let i = allNodes.length - 1; i >= 0; i--) {
    const node = allNodes[i];
    let hasActive = Boolean(activeLeafId && node.entry?.id === activeLeafId);
    for (const child of node.children) hasActive = hasActive || containsActive.get(child) === true;
    containsActive.set(node, hasActive);
  }

  const orderedChildren = (children) => {
    const active = [];
    const rest = [];
    for (const child of children) {
      if (containsActive.get(child)) active.push(child);
      else rest.push(child);
    }
    return [...active, ...rest];
  };

  const rows = [];
  const multipleRoots = roots.length > 1;
  const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
  const stack = [];
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, i === orderedRoots.length - 1, multipleRoots]);
  }

  while (stack.length) {
    const [node, indent, justBranched, showConnector, isLast, isVirtualRootChild] = stack.pop();
    const entry = node.entry;
    const depth = multipleRoots ? Math.max(0, indent - 1) : indent;
    const connector = showConnector && !isVirtualRootChild ? (isLast ? "└" : "├") : (depth > 0 ? "│" : "");
    rows.push({
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      type: entry.type,
      role: entry.message?.role,
      text: treeDisplayText(entry),
      depth,
      connector,
      active: activeIds.has(entry.id),
      current: entry.id === activeLeafId,
      message: entry.type === "message" && Boolean(entry.message),
    });

    const children = orderedChildren(node.children);
    const multipleChildren = children.length > 1;
    const childIndent = multipleChildren ? indent + 1 : (justBranched && indent > 0 ? indent + 1 : indent);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([children[i], childIndent, multipleChildren, multipleChildren, i === children.length - 1, false]);
    }
  }
  return rows;
}

function contentParts(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text) parts.push({ type: "text", text: part.text });
    else if (typeof part.thinking === "string" && part.thinking) parts.push({ type: "text", text: part.thinking });
    else if (typeof part.name === "string") {
      const details = shortJson(part.input ?? part.arguments ?? part.args);
      parts.push({ type: "tool", name: part.name, call: details, results: [], error: false });
    }
  }
  return parts;
}

function chatTurns(entries, toMessage) {
  const turns = [];
  let assistant = null;
  const pendingTools = [];
  const ensureAssistant = () => {
    if (!assistant) {
      assistant = { role: "assistant", ids: [], parts: [], error: false };
      turns.push(assistant);
    }
    return assistant;
  };

  for (const entry of entries) {
    const message = entry.message;
    if (message.role === "user") {
      assistant = null;
      pendingTools.length = 0;
      turns.push({ role: "user", message: toMessage(entry) });
      continue;
    }

    if (message.role === "assistant" && assistant?.error) {
      assistant = null;
      pendingTools.length = 0;
    }

    const turn = ensureAssistant();
    turn.ids.push(entry.id);
    if (message.role === "assistant") {
      turn.error = turn.error || Boolean(message.errorMessage || message.isError);
      for (const part of contentParts(message.content)) {
        part.error = part.error || Boolean(message.errorMessage || message.isError);
        turn.parts.push(part);
        if (part.type === "tool") pendingTools.push(part);
      }
      if (message.errorMessage && !turn.parts.length) turn.parts.push({ type: "text", text: message.errorMessage });
      continue;
    }

    const part = pendingTools.shift() || { type: "tool", name: message.toolName || message.role || "tool", call: "", results: [], error: false };
    if (!turn.parts.includes(part)) turn.parts.push(part);
    part.name = message.toolName || part.name;
    part.error = part.error || Boolean(message.errorMessage || message.isError);
    part.results.push(textOfContent(message.content) || message.errorMessage || "(no output)");
  }

  for (const turn of turns) {
    if (turn.role === "assistant" && !turn.parts.length) turn.parts.push({ type: "text", text: "" });
  }
  return turns;
}

export function sessionPayload(runtime) {
  const session = runtime.session;
  const sm = session.sessionManager;
  const activeBranch = sm.getBranch();
  const activeLeafId = sm.getLeafId?.() ?? activeBranch[activeBranch.length - 1]?.id ?? null;
  const activeEntries = activeBranch.filter((entry) => entry.type === "message" && entry.message);
  const activeIds = new Set(activeBranch.map((entry) => entry.id));
  const toMessage = (entry) => ({
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    role: entry.message?.role ?? "assistant",
    text: textOfContent(entry.message?.content),
    error: entry.message?.errorMessage,
    stopReason: entry.message?.stopReason,
    toolName: entry.message?.toolName,
    isError: entry.message?.isError,
  });

  const roots = sm.getTree();

  return {
    cwd: runtime.cwd,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    sessionName: sm.getSessionName?.(),
    leafId: activeLeafId,
    isStreaming: session.isStreaming,
    systemPrompt: systemPromptOf(session),
    messages: activeEntries.map((entry) => toMessage(entry)),
    turns: chatTurns(activeEntries, toMessage),
    tree: treeItems(roots, activeLeafId, activeIds),
  };
}

