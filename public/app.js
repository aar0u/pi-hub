import { BACKEND_OFFLINE_MESSAGE, api, isNetworkError, responseError } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { apiAuthHeaders, installApiTokenFromHash, readNdjsonStream, STREAM_AWARENESS_TIMEOUT_MS } from "./stream.js";
import { createFileSidebar } from "./sidebar-files.js";
import { createSessionSidebar } from "./sidebar-sessions.js";
import { $, compactText, formatDuration, icon, setIcon } from "./ui.js";

installApiTokenFromHash();

const state = { data: null, streaming: false, composing: false, abortController: null, abortRequested: false, autoScroll: true, backendOffline: false, filePath: ".", cwdChoices: [], slashCommands: [], slashIndex: 0, inspector: null, statusFlashToken: null };
let loadFiles;
let loadSessions;

const BACKEND_CHECK_INTERVAL_MS = 5_000;

function messageText(m) {
  if (m.error) return m.error;
  if (m.text) return m.text;
  return m.role === "assistant" ? "waiting…" : "";
}

function shortJson(value) {
  if (value === undefined) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textOfTreeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      if (part && typeof part === "object" && typeof part.thinking === "string") return part.thinking;
      if (part && typeof part === "object" && typeof part.name === "string") {
        const details = shortJson(part.input ?? part.arguments ?? part.args);
        return details ? `[tool: ${part.name}] ${details}` : `[tool: ${part.name}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isToolOnlyTreeContent(content) {
  if (!Array.isArray(content) || !content.length) return false;
  let hasTool = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text.trim()) return false;
    if (typeof part.thinking === "string" && part.thinking.trim()) return false;
    if (typeof part.name === "string" && part.name) hasTool = true;
  }
  return hasTool;
}

function shouldShowTreeItem(item) {
  if (item.type !== "message" || !item.message) return false;
  const role = item.message.role || "assistant";
  if (role === "user") return true;
  if (role !== "assistant") return false;
  if (item.message.errorMessage || item.message.isError) return true;
  return !isToolOnlyTreeContent(item.message.content);
}

function treeItemText(item) {
  if (item.type !== "message" || !item.message) return item.type || "entry";
  const text = textOfTreeContent(item.message.content) || item.message.errorMessage || item.message.toolName || "";
  return text.replace(/\s+/g, " ").trim();
}

function canCollapse(m) {
  return m.role === "user" || m.role === "assistant" || m.role === "toolResult" || m.role === "bashExecution" || m.role === "custom";
}

function messageSummary(m) {
  return compactText(messageText(m));
}

function assistantTurnSummary(messages) {
  const text = messages
    .map((m) => messageText(m))
    .join(" ")
    .replace(/^\s*\[tool: ([^\]]+)\].*$/gm, "tool: $1");
  return compactText(text);
}

function messageErrorDetail(m) {
  if (!m) return "";
  if (!m.errorDetail && !m.error && !m.isError) return "";
  return compactText(m.errorDetail || m.error || "Error");
}

function assistantTurnErrorDetail(messages) {
  return messageErrorDetail(messages.find((m) => m.role === "assistant" && messageErrorDetail(m)));
}

function setHeaderDetail(head, detail) {
  const text = compactText(detail);
  if (!text) return;
  const existing = head.querySelector(".msg-summary, .msg-detail");
  const detailEl = existing || document.createElement("span");
  detailEl.className = "msg-detail";
  detailEl.textContent = text;
  if (!existing) head.insertBefore(detailEl, head.children[1] || null);
}

function focusPrompt() {
  $("prompt")?.focus();
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function insertPromptText(text, replace = false) {
  const prompt = $("prompt");
  if (!prompt) return;
  if (replace) {
    prompt.value = text;
  } else {
    const prefix = prompt.value && !/\s$/.test(prompt.value) ? " " : "";
    prompt.value += `${prefix}${text}`;
  }
  prompt.focus();
  prompt.selectionStart = prompt.selectionEnd = prompt.value.length;
}

function setStreamingUi(streaming) {
  const send = $("send");
  setIcon(send, streaming ? "stop" : "send");
  send.title = streaming ? "Abort" : "Send";
  send.setAttribute("aria-label", streaming ? "Abort" : "Send");
}

function abortPrompt() {
  if (!state.streaming || !state.abortController) return;
  state.abortRequested = true;
  setStatus("Aborting…", "warning", { busy: true });
  state.abortController.abort();
}

function isNearChatBottom() {
  const chat = $("chat");
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
}

function scrollChatToBottom(force = false) {
  if (force || state.autoScroll) $("chat").scrollTop = $("chat").scrollHeight;
}

function renderState(data, opts = {}) {
  const chat = $("chat");
  const prevScrollTop = chat.scrollTop;
  const prevScrollHeight = chat.scrollHeight;
  updateChrome(data);
  chat.innerHTML = "";
  if (data.turns) renderChatTurns(data.turns, chat);
  else renderMessageRuns(data.messages || [], chat);
  updateResponsesFoldToggle();
  if (opts.preserveScroll) {
    chat.scrollTop = prevScrollTop + (chat.scrollHeight - prevScrollHeight);
  } else {
    state.autoScroll = true;
    scrollChatToBottom(true);
  }
}

function renderChatTurns(turns, container) {
  for (const turn of turns) {
    if (turn.role === "user") addMessage(turn.message, { container });
    else addAssistantTurnFromParts(turn, { container });
  }
}

function renderMessageRuns(messages, container) {
  let assistantRun = [];
  const flushAssistant = () => {
    if (!assistantRun.length) return;
    addAssistantTurn(assistantRun, { container });
    assistantRun = [];
  };
  for (const m of messages) {
    if (m.role === "user") {
      flushAssistant();
      addMessage(m, { container });
    } else {
      assistantRun.push(m);
    }
  }
  flushAssistant();
}

function splitAssistantParts(text) {
  const parts = [];
  const re = /^\s*\[tool: ([^\]]+)\](?:\s+([^\n]+))?\s*$/gm;
  let last = 0;
  let match;
  while ((match = re.exec(text || ""))) {
    const before = text.slice(last, match.index).trim();
    if (before) parts.push({ type: "text", text: before });
    parts.push({ type: "tool", name: match[1], call: match[2] || match[0].trim(), results: [], error: false });
    last = match.index + match[0].length;
  }
  const rest = (text || "").slice(last).trim();
  if (rest) parts.push({ type: "text", text: rest });
  return parts;
}

function toolPreview(command, name) {
  return (command || "")
    .replace(new RegExp(`^[✓▶…]\\s*${name || ""}\\s*(queued|running|done|update)?\\s*`, "i"), "")
    .trim();
}

function appendToolSummary(summary, label, command, name) {
  const title = document.createElement("span");
  title.className = "turn-tool-name";
  title.textContent = label;
  const preview = document.createElement("span");
  preview.className = "turn-tool-preview";
  preview.textContent = toolPreview(command, name);
  preview.title = preview.textContent;
  summary.append(title, preview);
}

function turnParts(messages) {
  const parts = [];
  const pendingTools = [];
  for (const m of messages) {
    const text = messageText(m);
    if (m.role === "assistant") {
      const detail = messageErrorDetail(m);
      for (const part of splitAssistantParts(text)) {
        part.error = part.error || Boolean(detail);
        parts.push(part);
        if (part.type === "tool") pendingTools.push(part);
      }
      continue;
    }

    const part = pendingTools.shift() || { type: "tool", name: m.toolName || m.role || "tool", call: "", results: [], error: false };
    if (!parts.includes(part)) parts.push(part);
    part.name = m.toolName || part.name;
    part.error = part.error || Boolean(messageErrorDetail(m));
    part.results.push(text || m.error || "(no output)");
  }
  return parts;
}

function setMessageCollapsed(el, collapsed) {
  el.classList.toggle("collapsed", collapsed);
  const indicator = el.firstElementChild?.querySelector(".collapse-indicator");
  if (indicator) setIcon(indicator, collapsed ? "chevron-down" : "chevron-up");
}

function updateResponsesFoldToggle() {
  const button = $("responsesFoldToggle");
  const responses = [...$("chat").querySelectorAll(".msg.assistant")];
  const canFold = responses.some((el) => !el.classList.contains("collapsed"));
  button.disabled = !responses.length;
  button.textContent = canFold || !responses.length ? "Fold" : "Unfold";
  button.title = canFold || !responses.length ? "Fold all responses" : "Unfold all responses";
}

function toggleAllResponses() {
  const responses = [...$("chat").querySelectorAll(".msg.assistant")];
  if (!responses.length) return;
  const collapse = responses.some((el) => !el.classList.contains("collapsed"));
  for (const el of responses) setMessageCollapsed(el, collapse);
  updateResponsesFoldToggle();
}

function addMessageAction(target, kind, label, iconName, onClick) {
  if (!target || !onClick) return;
  const actions = document.createElement("div");
  actions.className = `msg-actions ${kind}-actions`;
  const button = document.createElement("button");
  button.className = "msg-action";
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(iconName), label);
  button.onclick = onClick;
  actions.append(button);
  target.append(actions);
}

function addAssistantTurnFromParts(turn, opts = {}) {
  const target = opts.container || $("chat");
  const el = document.createElement("article");
  el.className = `msg assistant turn ${turn.error ? "error" : ""}`;
  const ids = turn.ids || [];
  if (ids.length) {
    el.dataset.id = ids[ids.length - 1];
    el.dataset.ids = ids.join(" ");
  }
  const head = document.createElement("div");
  head.className = "msg-head";
  const role = document.createElement("span");
  role.textContent = "assistant";
  const summaryText = document.createElement("span");
  const detail = turn.errorDetail || turn.detail || "";
  summaryText.className = detail ? "msg-detail" : "msg-summary";
  summaryText.textContent = detail ? compactText(detail) : compactText((turn.parts || []).map((part) => part.type === "text" ? part.text : `tool: ${part.name}`).join(" "));
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const indicator = document.createElement("span");
  indicator.className = "collapse-indicator";
  indicator.append(icon("chevron-up"));
  head.append(role, summaryText, spacer, indicator);
  head.title = "Collapse/expand";
  head.onclick = () => {
    setMessageCollapsed(el, !el.classList.contains("collapsed"));
    updateResponsesFoldToggle();
  };

  const body = document.createElement("div");
  body.className = "msg-body turn-body";
  for (const part of turn.parts || []) {
    if (part.type === "text") {
      if (!part.text) continue;
      const section = document.createElement("div");
      section.className = "turn-text";
      renderMarkdown(part.text, section);
      body.append(section);
      continue;
    }

    const tool = document.createElement("details");
    tool.className = `turn-tool ${part.error ? "error" : ""}`;
    const summary = document.createElement("summary");
    appendToolSummary(summary, part.name || "tool", part.call, part.name);
    const content = document.createElement("div");
    content.className = "turn-tool-body";
    const command = document.createElement("div");
    command.className = "turn-tool-command";
    command.textContent = part.call || part.name || "tool";
    const result = document.createElement("div");
    result.className = "turn-tool-result";
    result.textContent = part.results?.length ? part.results.join("\n\n") : "(no output)";
    content.append(command, result);
    tool.append(summary, content);
    body.append(tool);
  }
  if (!body.childElementCount) body.textContent = "";

  el.append(head, body);
  target.append(el);
  const forkEntry = ids[ids.length - 1];
  if (forkEntry) addMessageAction(el, "assistant", "Fork from here", "fork", () => doFork(forkEntry));
  if (target === $("chat")) scrollChatToBottom();
  return { el, body };
}

function addAssistantTurn(messages, opts = {}) {
  const target = opts.container || $("chat");
  const el = document.createElement("article");
  el.className = `msg assistant turn ${assistantTurnErrorDetail(messages) ? "error" : ""}`;
  const ids = messages.map((m) => m.id).filter(Boolean);
  if (ids.length) {
    el.dataset.id = ids[ids.length - 1];
    el.dataset.ids = ids.join(" ");
  }
  const head = document.createElement("div");
  head.className = "msg-head";
  const role = document.createElement("span");
  role.textContent = "assistant";
  const summaryText = document.createElement("span");
  const detail = assistantTurnErrorDetail(messages);
  summaryText.className = detail ? "msg-detail" : "msg-summary";
  summaryText.textContent = detail || assistantTurnSummary(messages);
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const indicator = document.createElement("span");
  indicator.className = "collapse-indicator";
  indicator.append(icon("chevron-up"));
  head.append(role, summaryText, spacer, indicator);
  head.title = "Collapse/expand";
  head.onclick = () => {
    setMessageCollapsed(el, !el.classList.contains("collapsed"));
    updateResponsesFoldToggle();
  };

  const body = document.createElement("div");
  body.className = "msg-body turn-body";
  for (const part of turnParts(messages)) {
    if (part.type === "text") {
      const section = document.createElement("div");
      section.className = "turn-text";
      renderMarkdown(part.text, section);
      body.append(section);
      continue;
    }

    const tool = document.createElement("details");
    tool.className = `turn-tool ${part.error ? "error" : ""}`;
    const summary = document.createElement("summary");
    appendToolSummary(summary, part.name, part.call, part.name);
    const content = document.createElement("div");
    content.className = "turn-tool-body";
    const command = document.createElement("div");
    command.className = "turn-tool-command";
    command.textContent = part.call || part.name;
    const result = document.createElement("div");
    result.className = "turn-tool-result";
    result.textContent = part.results.length ? part.results.join("\n\n") : "(no output)";
    content.append(command, result);
    tool.append(summary, content);
    body.append(tool);
  }

  el.append(head, body);
  target.append(el);
  const forkEntry = [...messages].reverse().find((m) => m.id)?.id;
  if (forkEntry) addMessageAction(el, "assistant", "Fork from here", "fork", () => doFork(forkEntry));
  if (target === $("chat")) scrollChatToBottom();
  return { el, body };
}

function addMessage(m, opts = {}) {
  const target = opts.container || $("chat");
  const el = document.createElement("article");
  el.className = `msg ${m.role || "assistant"} ${m.error || m.isError ? "error" : ""}`;
  el.dataset.id = m.id || "";
  const head = document.createElement("div");
  head.className = "msg-head";
  const role = document.createElement("span");
  role.textContent = m.toolName ? `${m.role || "tool"}: ${m.toolName}` : (m.role || "assistant");
  const summaryText = document.createElement("span");
  const detail = messageErrorDetail(m);
  summaryText.className = detail ? "msg-detail" : "msg-summary";
  summaryText.textContent = detail || messageSummary(m);
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.append(role, summaryText, spacer);
  if (canCollapse(m)) {
    const defaultCollapsed = m.role === "toolResult";
    if (defaultCollapsed) el.classList.add("collapsed");
    const indicator = document.createElement("span");
    indicator.className = "collapse-indicator";
    indicator.append(icon(defaultCollapsed ? "chevron-down" : "chevron-up"));
    head.append(indicator);
    head.title = "Collapse/expand";
    head.onclick = (ev) => {
      if (ev.target.closest("button")) return;
      setMessageCollapsed(el, !el.classList.contains("collapsed"));
      updateResponsesFoldToggle();
    };
  }
  const body = document.createElement("div");
  body.className = "msg-body";
  renderMarkdown(messageText(m), body);
  if (opts.pending) {
    const p = document.createElement("span");
    p.className = "pending";
    p.textContent = " pending…";
    body.append(p);
  }
  el.append(head, body);
  target.append(el);
  if (m.role === "user" && m.id) addMessageAction(el, "user", "Edit from here", "navigate", () => doEditHere(m.id));
  if (m.role === "assistant" && m.id) addMessageAction(el, "assistant", "Fork from here", "fork", () => doFork(m.id));
  if (target === $("chat")) {
    updateResponsesFoldToggle();
    scrollChatToBottom();
  }
  return { el, head, body };
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function formatCount(value) {
  if (!Number.isFinite(value)) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function formatCost(value) {
  return Number.isFinite(value) && value > 0 ? `$${value.toFixed(value < 0.01 ? 4 : 2)}` : "";
}

function contextStatusText(contextUsage) {
  if (!contextUsage) return "context ?";
  const windowText = formatCount(contextUsage.contextWindow);
  if (contextUsage.tokens === null || contextUsage.tokens === undefined) return `context ?/${windowText}`;
  const percent = Number.isFinite(contextUsage.percent) ? ` ${Math.round(contextUsage.percent)}%` : "";
  return `context ${formatCount(contextUsage.tokens)}/${windowText}${percent}`;
}

function updatePromptStatus(data = state.data) {
  const status = $("promptStatus");
  if (!status) return;
  status.innerHTML = "";
  if (!data) return;

  const addItem = (kind, text, title = text) => {
    if (!text) return;
    const item = document.createElement("span");
    item.className = `composer-status-item ${kind}`;
    item.textContent = text;
    item.title = title;
    status.append(item);
  };

  const stats = data.stats || {};
  const tokens = stats.tokens || {};
  const contextUsage = stats.contextUsage || (data.model?.contextWindow ? { tokens: null, contextWindow: data.model.contextWindow, percent: null } : null);
  addItem("model", data.model?.id || data.model?.name || "model ?", data.model?.provider ? `${data.model.provider}: ${data.model.id}` : undefined);
  addItem("context", contextStatusText(contextUsage));
  addItem("messages", `${stats.totalMessages ?? (data.messages?.length ?? 0)} msg`);

  const tokenText = [tokens.input ? `in ${formatCount(tokens.input)}` : "", tokens.output ? `out ${formatCount(tokens.output)}` : "", tokens.cacheRead ? `cache ${formatCount(tokens.cacheRead)}` : ""].filter(Boolean).join(" / ");
  addItem("tokens", tokenText);
  addItem("cost", formatCost(stats.cost));
  if (data.thinkingLevel && data.thinkingLevel !== "off") addItem("thinking", `thinking ${data.thinkingLevel}`);
  addItem("error", stats.error ? `stats error` : "", stats.error);

  status.title = [...status.children].map((el) => el.title || el.textContent).filter(Boolean).join(" · ");
}

const STATUS_CLASSES = ["status-busy", "status-flash", "status-notice", "status-warning", "status-error"];

function clearStatusTone() {
  state.statusFlashToken = null;
  $("status").classList.remove(...STATUS_CLASSES);
}

function setStatus(message, kind = "notice", opts = {}) {
  const status = $("status");
  const tone = `status-${kind}`;
  state.statusFlashToken = null;
  status.textContent = message;
  status.classList.remove(...STATUS_CLASSES);
  status.classList.add(tone);
  if (opts.busy) status.classList.add("status-busy");
}

function markBackendOffline() {
  state.backendOffline = true;
  setStatus(BACKEND_OFFLINE_MESSAGE, "error");
  $("status").classList.add("backend-offline");
}

async function checkBackend() {
  if (state.streaming) return;
  try {
    const data = await api("/api/state");
    if (state.backendOffline) updateChrome(data);
    state.backendOffline = false;
  } catch (err) {
    markBackendOffline();
  }
}

async function runAction(action, message = "Working…") {
  setStatus(message, "warning", { busy: true });
  try {
    await action();
  } catch (err) {
    flashStatus(errorMessage(err), "error");
  } finally {
    $("status").classList.remove("status-busy");
    if ($("status").textContent === message) {
      if (state.data) updateChrome(state.data);
      else clearStatusTone();
    }
  }
}

function flashStatus(message, kind = "notice") {
  setStatus(message, kind);
  const status = $("status");
  const token = Symbol("status-flash");
  state.statusFlashToken = token;
  void status.offsetWidth;
  status.classList.add("status-flash");
  setTimeout(() => {
    if (state.statusFlashToken !== token) return;
    status.classList.remove("status-flash", `status-${kind}`);
    state.statusFlashToken = null;
  }, 1100);
}

function locateMessage(entryId) {
  if (!entryId) return false;
  const chat = $("chat");
  const target = chat.querySelector(`[data-id="${CSS.escape(entryId)}"], [data-ids~="${CSS.escape(entryId)}"]`);
  chat.querySelectorAll(".located").forEach((el) => el.classList.remove("located"));
  if (!target) return false;
  target.classList.add("located");
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  setTimeout(() => target.classList.remove("located"), 1600);
  return true;
}

function locateTreeItem(item) {
  if (!item?.id) return;
  if (item.active && locateMessage(item.id)) return;
  flashStatus("This tree node is off the active chat path. Use Fork to open it without rewinding the current session.", "warning");
}

function treeNodeButton(item) {
  const row = document.createElement("div");
  row.className = "tree-row";

  const node = document.createElement("button");
  const textValue = treeItemText(item);
  node.type = "button";
  node.className = `tree-node ${item.active ? "active" : "off-branch"} ${item.current ? "current" : ""}`;
  node.title = textValue || item.id;
  node.onclick = () => locateTreeItem(item);
  const marker = document.createElement("span");
  marker.className = `tree-marker ${item.message?.role || "entry"}`;
  marker.title = item.message?.role || item.type || "entry";
  marker.textContent = item.current ? "●" : (item.message?.role === "user" ? "→" : "");
  const text = document.createElement("span");
  text.className = "tree-text";
  text.textContent = textValue || item.id;
  const id = document.createElement("span");
  id.className = "tree-id";
  id.textContent = item.id;
  node.append(marker, text, id);
  row.append(node);

  if (item.message?.role === "assistant") {
    const actions = document.createElement("span");
    actions.className = "tree-actions";
    const fork = document.createElement("button");
    fork.className = "tree-action";
    fork.type = "button";
    fork.title = "Fork from here";
    fork.setAttribute("aria-label", "Fork from here");
    fork.append(icon("fork"));
    fork.onclick = () => void doFork(item.id);
    actions.append(fork);
    row.append(actions);
  }

  return row;
}

function hasVisibleTreeItem(item) {
  if (shouldShowTreeItem(item)) return true;
  return (item.children || []).some(hasVisibleTreeItem);
}

function visibleChildBranches(item) {
  return (item.children || []).filter(hasVisibleTreeItem);
}

function appendTreeItem(container, item) {
  const visible = shouldShowTreeItem(item);
  const childBranches = visibleChildBranches(item);
  let childContainer = container;
  if (visible) {
    const group = document.createElement("div");
    group.className = "tree-group";
    group.append(treeNodeButton(item));
    if (childBranches.length > 1) {
      childContainer = document.createElement("div");
      childContainer.className = "tree-children";
      group.append(childContainer);
    }
    container.append(group);
  }
  for (const child of childBranches) appendTreeItem(childContainer, child);
}

function renderTreePanel(data = state.data) {
  const panel = $("systemPanel");
  panel.innerHTML = "";
  const items = data?.tree || [];
  panel.classList.toggle("empty", !items.length);
  if (!items.length) {
    panel.textContent = "No tree entries yet.";
    return;
  }

  const tree = document.createElement("div");
  tree.className = "tree-view";
  for (const item of items) appendTreeItem(tree, item);
  if (!tree.querySelector(".tree-node")) {
    panel.textContent = "No message nodes in this tree.";
  } else {
    panel.append(tree);
    tree.querySelector(".tree-node.current")?.scrollIntoView({ block: "center" });
  }
}

function updateInspectorPanel(data = state.data) {
  const panel = $("systemPanel");
  if (!panel || panel.hidden) return;
  if (state.inspector === "tree") {
    renderTreePanel(data);
    return;
  }
  const prompt = data?.systemPrompt;
  panel.classList.toggle("empty", !prompt);
  panel.textContent = prompt || (prompt === "" ? "System prompt is empty." : "Send a message to load the system prompt.");
  panel.scrollTop = 0;
}

function renderCwdMenu() {
  const menu = $("cwdMenu");
  if (!menu) return;
  menu.innerHTML = "";
  for (const cwd of state.cwdChoices) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = cwd;
    item.title = cwd;
    item.onclick = () => void runAction(() => switchCwd(cwd), "Switching directory…");
    menu.append(item);
  }
  menu.hidden = !state.cwdChoices.length;
}

function hideCwdMenuSoon() {
  setTimeout(() => {
    const active = document.activeElement;
    if (active?.closest?.("#cwdForm")) return;
    $("cwdMenu").hidden = true;
  }, 120);
}

async function loadCwdOptions() {
  state.cwdChoices = await api("/api/cwds");
  if (!$("cwdMenu")?.hidden) renderCwdMenu();
}

async function loadSlashCommands() {
  state.slashCommands = await api("/api/commands");
  renderSlashMenu();
}

function slashQuery() {
  const prompt = $("prompt");
  const beforeCursor = prompt.value.slice(0, prompt.selectionStart ?? prompt.value.length);
  const match = beforeCursor.match(/^\/([^\s]*)$/);
  return match ? match[1].toLowerCase() : null;
}

function slashMatches() {
  const query = slashQuery();
  if (query === null) return [];
  return state.slashCommands
    .filter((command) => command.name.toLowerCase().includes(query))
    .slice(0, 12);
}

function insertSlashCommand(command) {
  const prompt = $("prompt");
  prompt.value = `/${command.name} `;
  prompt.focus();
  prompt.selectionStart = prompt.selectionEnd = prompt.value.length;
  hideSlashMenu();
}

function hideSlashMenu() {
  const menu = $("slashMenu");
  if (menu) menu.hidden = true;
}

function renderSlashMenu() {
  const menu = $("slashMenu");
  if (!menu) return;
  const matches = slashMatches();
  state.slashIndex = Math.min(state.slashIndex, Math.max(0, matches.length - 1));
  menu.innerHTML = "";
  for (const [index, command] of matches.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = index === state.slashIndex ? "active" : "";
    item.title = command.description || command.name;
    item.onmousedown = (ev) => ev.preventDefault();
    item.onclick = () => insertSlashCommand(command);

    const name = document.createElement("span");
    name.className = "slash-name";
    name.textContent = `/${command.name}`;

    const desc = document.createElement("span");
    desc.className = "slash-desc";
    desc.textContent = command.description || "";

    const source = document.createElement("span");
    source.className = "slash-source";
    source.textContent = command.source || "";

    item.append(name, desc, source);
    menu.append(item);
  }
  menu.hidden = !matches.length;
}

function moveSlashSelection(delta) {
  const matches = slashMatches();
  if (!matches.length) return;
  state.slashIndex = (state.slashIndex + delta + matches.length) % matches.length;
  renderSlashMenu();
}

function acceptSlashSelection() {
  const command = slashMatches()[state.slashIndex];
  if (command) insertSlashCommand(command);
}

function updateChrome(data) {
  const previousCwd = state.data?.cwd;
  state.data = data;
  if (previousCwd !== data.cwd) state.filePath = ".";
  $("cwd").value = data.cwd || "";
  $("status").classList.remove("backend-offline");
  clearStatusTone();
  $("status").textContent = data.sessionId || "new session";
  updatePromptStatus(data);
  updateInspectorPanel(data);
}

async function updateSidebarData(opts = {}) {
  const tasks = [loadSessions(), loadCwdOptions(), loadSlashCommands()];
  if (opts.loadFiles !== false) tasks.push(loadFiles());
  await Promise.all(tasks);
}

async function refresh(opts = {}) {
  renderState(await api("/api/state"), opts);
  await updateSidebarData();
}

async function syncStateWithoutRerender() {
  updateChrome(await api("/api/state"));
  await updateSidebarData();
}

async function sessionAction(endpoint, entryId) {
  try {
    const data = await api(endpoint, { method: "POST", body: JSON.stringify({ entryId }) });
    renderState(data);
    await updateSidebarData();
    return data;
  } catch (err) {
    flashStatus(errorMessage(err), "error");
    await refresh();
    return null;
  }
}

const doFork = (entryId) => sessionAction("/api/fork", entryId);
const doEditHere = async (entryId) => {
  const data = await sessionAction("/api/navigate-tree", entryId);
  if (typeof data?.navigation?.editorText === "string") insertPromptText(data.navigation.editorText, true);
};

loadFiles = createFileSidebar({ state, api, $, errorMessage, insertPromptText });
loadSessions = createSessionSidebar({ state, api, $, icon, runAction, refresh, renderState, updateSidebarData });

async function sendPrompt(text) {
  state.streaming = true;
  state.abortRequested = false;
  state.autoScroll = true;
  setStreamingUi(true);
  addMessage({ role: "user", text });
  const assistant = addMessage({ role: "assistant", text: "waiting… (0s)" });
  assistant.body.classList.add("turn-body");
  const controller = new AbortController();
  state.abortController = controller;
  let output = "";
  const streamParts = [];
  let activeToolPart = null;
  let gotVisibleResponse = false;
  let streamWarningShown = false;
  let latestPromptState = null;
  let lastStreamEventAt = Date.now();
  const startTime = Date.now();
  const progressInterval = setInterval(() => {
    const now = Date.now();
    const idleMs = now - lastStreamEventAt;
    if (!gotVisibleResponse) {
      const elapsed = Math.floor((now - startTime) / 1000);
      assistant.body.textContent = `waiting… (${elapsed}s)`;
      if (idleMs > STREAM_AWARENESS_TIMEOUT_MS && !streamWarningShown) {
        streamWarningShown = true;
        setStatus(`No visible response for ${formatDuration(idleMs)}; still waiting.`, "warning");
      }
      return;
    }
    if (activeToolPart && activeToolPart.phase !== "done") renderAssistant();
    if (idleMs > STREAM_AWARENESS_TIMEOUT_MS) {
      setStatus(`No stream updates for ${formatDuration(idleMs)}; backend/tool may be stuck.`, "warning");
    }
  }, 1000);
  const appendTextDelta = (delta) => {
    output += delta;
    let part = streamParts[streamParts.length - 1];
    if (!part || part.type !== "text") {
      part = { type: "text", text: "" };
      streamParts.push(part);
    }
    part.text += delta;
  };
  const appendToolEvent = (evt) => {
    const name = evt.toolName || activeToolPart?.name || "tool";
    if (evt.phase === "done") flashStatus(`${name} done`);
    else setStatus(`Running ${name}…`, "warning", { busy: true });
    if (!activeToolPart || activeToolPart.phase === "done") {
      activeToolPart = { type: "tool", name, phase: evt.phase || "running", startedAt: Date.now(), endedAt: null, command: "", messages: [], error: false };
      streamParts.push(activeToolPart);
    }
    activeToolPart.name = name;
    activeToolPart.phase = evt.phase || activeToolPart.phase || "running";
    if (activeToolPart.phase === "done" && !activeToolPart.endedAt) activeToolPart.endedAt = Date.now();
    activeToolPart.error = Boolean(evt.isError || activeToolPart.error);
    if (evt.message) {
      if (evt.phase === "queued" || evt.phase === "running") activeToolPart.command = evt.message;
      else activeToolPart.messages.push(evt.message);
    }
  };
  const renderAssistant = () => {
    assistant.body.textContent = "";
    for (const part of streamParts) {
      if (part.type === "text") {
        const visibleText = splitAssistantParts(part.text)
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n\n");
        if (!visibleText) continue;
        const text = document.createElement("div");
        text.className = "turn-text";
        renderMarkdown(visibleText, text);
        assistant.body.append(text);
        continue;
      }

      const tool = document.createElement("details");
      tool.className = `turn-tool ${part.error ? "error" : ""}`;
      tool.open = part.phase !== "done";
      const summary = document.createElement("summary");
      const duration = formatDuration((part.endedAt || Date.now()) - part.startedAt);
      const phaseText = part.phase === "done" ? `done in ${duration}` : `${part.phase || "running"} for ${duration}`;
      appendToolSummary(summary, `${part.name || "tool"} · ${phaseText}`, part.command, part.name);
      const content = document.createElement("div");
      content.className = "turn-tool-body";
      const command = document.createElement("div");
      command.className = "turn-tool-command";
      command.textContent = part.command || part.name || "tool";
      const result = document.createElement("div");
      result.className = "turn-tool-result";
      result.textContent = part.messages.length ? part.messages.join("\n\n") : (part.phase === "done" ? "(no output)" : "running…");
      content.append(command, result);
      tool.append(summary, content);
      assistant.body.append(tool);
    }
    if (!assistant.body.childElementCount) assistant.body.textContent = activeToolPart ? "working…" : "waiting…";
  };
  const markVisible = () => {
    gotVisibleResponse = true;
  };
  try {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json", ...apiAuthHeaders() },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw await responseError(res);
    await readNdjsonStream(res, (evt) => {
      lastStreamEventAt = Date.now();
      if (evt.type === "ping") return;
      if (evt.type === "delta") {
        markVisible();
        appendTextDelta(evt.delta || "");
        renderAssistant();
      }
      if (evt.type === "tool") {
        markVisible();
        appendToolEvent(evt);
        renderAssistant();
      }
      if (evt.type === "error") {
        markVisible();
        assistant.el.classList.add("error");
        assistant.body.textContent = evt.message || "Unknown error";
        setHeaderDetail(assistant.head, assistant.body.textContent);
        if (evt.state) {
          latestPromptState = evt.state;
          state.data = evt.state;
        }
      }
      if ((evt.type === "done" || evt.type === "state") && evt.state) {
        latestPromptState = evt.state;
        state.data = evt.state;
      }
      scrollChatToBottom();
    });
    if (!gotVisibleResponse && !output) {
      assistant.el.classList.add("error");
      assistant.body.textContent = "No response content received.";
      setHeaderDetail(assistant.head, assistant.body.textContent);
    }
  } catch (err) {
    assistant.el.classList.add("error");
    const disconnected = !state.abortRequested && isNetworkError(err);
    assistant.body.textContent = state.abortRequested ? "Request aborted." : (disconnected ? BACKEND_OFFLINE_MESSAGE : errorMessage(err));
    setHeaderDetail(assistant.head, assistant.body.textContent);
    if (disconnected) markBackendOffline();
  } finally {
    clearInterval(progressInterval);
    state.streaming = false;
    state.abortController = null;
    state.abortRequested = false;
    setStreamingUi(false);
    if (latestPromptState) {
      renderState(latestPromptState);
      await updateSidebarData().catch(() => markBackendOffline());
    } else {
      await syncStateWithoutRerender().catch(() => markBackendOffline());
    }
  }
}

$("chat").addEventListener("scroll", () => {
  state.autoScroll = isNearChatBottom();
});

$("promptForm").onsubmit = async (ev) => {
  ev.preventDefault();
  if (state.streaming) {
    abortPrompt();
    return;
  }
  const text = $("prompt").value.trim();
  if (!text) return;
  hideSlashMenu();
  $("prompt").value = "";
  await sendPrompt(text);
};
$("prompt").addEventListener("compositionstart", () => state.composing = true);
$("prompt").addEventListener("compositionend", () => state.composing = false);
$("prompt").addEventListener("keydown", (ev) => {
  if (!$("slashMenu").hidden && (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Tab")) {
    ev.preventDefault();
    if (ev.key === "Tab") acceptSlashSelection();
    else moveSlashSelection(ev.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (!$("slashMenu").hidden && ev.key === "Escape") {
    ev.preventDefault();
    hideSlashMenu();
    return;
  }
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !state.composing) {
    ev.preventDefault();
    $("promptForm").requestSubmit();
  }
});
$("prompt").addEventListener("input", () => {
  state.slashIndex = 0;
  renderSlashMenu();
});
$("prompt").addEventListener("click", renderSlashMenu);
$("prompt").addEventListener("blur", () => setTimeout(hideSlashMenu, 120));
document.addEventListener("keydown", (ev) => {
  const isFocusShortcut = ev.key === "/" && (ev.metaKey || ev.ctrlKey) && !ev.altKey;
  if (!isFocusShortcut || isEditableTarget(ev.target)) return;
  ev.preventDefault();
  focusPrompt();
});
async function switchCwd(nextCwd) {
  if (!nextCwd) return;
  $("cwdMenu").hidden = true;
  const data = await api("/api/cwd", { method: "POST", body: JSON.stringify({ cwd: nextCwd }) });
  renderState(data);
  if (data.cwdCreated) flashStatus(`Created directory: ${data.cwd}`, "notice");
  await updateSidebarData();
}

function submitCwdSwitch() {
  void runAction(() => switchCwd($("cwd").value), "Switching directory…");
}

$("cwdForm").onsubmit = (ev) => {
  ev.preventDefault();
  submitCwdSwitch();
};
$("cwd").onfocus = renderCwdMenu;
$("cwd").onblur = hideCwdMenuSoon;
$("cwd").oninput = renderCwdMenu;
$("newSession").onclick = () => void runAction(async () => { renderState(await api("/api/sessions/new", { method: "POST" })); await updateSidebarData(); focusPrompt(); }, "Creating session…");
function closeInspector() {
  const panel = $("systemPanel");
  state.inspector = null;
  panel.hidden = true;
  $("systemToggle").classList.remove("active");
  $("treeToggle").classList.remove("active");
}

function toggleInspector(kind) {
  const panel = $("systemPanel");
  const nextHidden = state.inspector === kind && !panel.hidden;
  if (nextHidden) {
    closeInspector();
    return;
  }
  state.inspector = kind;
  panel.hidden = false;
  $("systemToggle").classList.toggle("active", kind === "system");
  $("treeToggle").classList.toggle("active", kind === "tree");
  updateInspectorPanel();
}

$("responsesFoldToggle").onclick = toggleAllResponses;
$("systemToggle").onclick = () => toggleInspector("system");
$("treeToggle").onclick = () => toggleInspector("tree");
document.addEventListener("click", (ev) => {
  if ($("systemPanel").hidden) return;
  if (ev.target.closest("#systemPanel, #responsesFoldToggle, #systemToggle, #treeToggle")) return;
  closeInspector();
});

setInterval(() => void checkBackend(), BACKEND_CHECK_INTERVAL_MS);

refresh().catch((err) => { flashStatus(errorMessage(err), "error"); });
