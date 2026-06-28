import { textOfContent } from "./session-state.mjs";
import { writeNdjson } from "./http.mjs";

function shortText(value, max = 400) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolMessage(status, toolName, details) {
  const icon = status === "done" ? "✓" : status === "pending" ? "…" : "▶";
  const suffix = details === undefined ? "" : ` ${shortText(details)}`;
  const label = status === "done" ? "done" : status === "pending" ? "queued" : "running";
  return `${icon} ${toolName} ${label}${suffix}`;
}

function toolPreview(details) {
  return details === undefined ? "" : shortText(details);
}

function argsText(args) {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? "");
  } catch {
    return String(args ?? "");
  }
}

function skillLabel(args) {
  const name = argsText(args).match(/\/skills\/([^/\s"']+)/)?.[1];
  return name ? `skill:${name}` : "";
}

function createAssistantStreamState() {
  return {
    nextTextPartId: 0,
    nextThinkingPartId: 0,
    nextToolPartId: 0,
    activeTextPartId: null,
    activeThinkingPartId: null,
    activeToolPartId: null,
    thinkingParts: new Map(),
    toolParts: new Map(),
    toolPartsByCallId: new Map(),
    startedParts: new Set(),
    openParts: new Set(),
    responseStarted: false,
  };
}

function contentKey(update) {
  return update?.contentIndex === undefined || update.contentIndex === null ? null : String(update.contentIndex);
}

function rememberPart(map, key, partId) {
  if (key !== null) map.set(key, partId);
}

function partFor(map, key, fallback) {
  return (key === null ? null : map.get(key)) || fallback;
}

function forgetPart(map, key) {
  if (key !== null) map.delete(key);
}

function writeResponseStart(write, stream) {
  if (stream.responseStarted) return;
  stream.responseStarted = true;
  write?.({ type: "response_start" });
}

function writePartStart(write, stream, event) {
  writeResponseStart(write, stream);
  if (stream.startedParts.has(event.partId)) return;
  stream.startedParts.add(event.partId);
  stream.openParts.add(event.partId);
  write?.({ type: "part_start", ...event });
}

function writePartEnd(write, stream, event) {
  if (!event.partId || !stream.openParts.has(event.partId)) return;
  stream.openParts.delete(event.partId);
  write?.({ type: "part_end", ...event });
}

function closeOpenParts(write, stream, status = "done") {
  for (const partId of [...stream.openParts]) writePartEnd(write, stream, { partId, status });
  stream.activeTextPartId = null;
  stream.activeThinkingPartId = null;
  stream.activeToolPartId = null;
}

function endActiveTextPart(write, stream) {
  if (!stream.activeTextPartId) return;
  writePartEnd(write, stream, { partId: stream.activeTextPartId, status: "done" });
  stream.activeTextPartId = null;
}

function toolCallPartId(stream, toolCallId) {
  if (!toolCallId) return null;
  const existing = stream.toolPartsByCallId.get(toolCallId);
  if (existing) return existing;
  const partId = `tool:${toolCallId}`;
  stream.toolPartsByCallId.set(toolCallId, partId);
  return partId;
}

function ensureToolPart(write, stream, event) {
  endActiveTextPart(write, stream);
  let partId = toolCallPartId(stream, event.toolCallId) || stream.activeToolPartId;
  if (!partId) {
    partId = `tool:execution:${++stream.nextToolPartId}`;
    stream.activeToolPartId = partId;
  }
  writePartStart(write, stream, {
    type: "part_start",
    partId,
    kind: "tool",
    title: event.toolName || "tool",
    status: "pending",
  });
  return partId;
}

function subscribePromptEventSink(session, { write = null, onEvent = null } = {}) {
  // State is scoped to one prompt request. Do not reset on message_start:
  // upstream may emit message_start-like events inside the same response.
  let assistantStream = createAssistantStreamState();
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_start":
        writeResponseStart(write, assistantStream);
        return;
      case "message_update":
        writeAssistantUpdate(write, event.assistantMessageEvent, assistantStream, onEvent);
        return;
      case "tool_execution_start": {
        const partId = ensureToolPart(write, assistantStream, event);
        write?.({
          type: "part_update",
          partId,
          status: "running",
          title: event.toolName,
          preview: toolPreview(event.args),
          metadata: { toolCallId: event.toolCallId },
          message: toolMessage("running", event.toolName, event.args),
        });
        return;
      }
      case "tool_execution_update": {
        const partId = ensureToolPart(write, assistantStream, event);
        // pi's interactive UI treats partialResult as the current result snapshot
        // (ToolExecutionComponent.updateResult(result, true) replaces the result),
        // so stream part_update uses replace semantics instead of appending chunks.
        write?.({ type: "part_update", partId, status: "running", result: textOfContent(event.partialResult?.content) });
        return;
      }
      case "tool_execution_end": {
        const partId = ensureToolPart(write, assistantStream, event);
        const resultText = event.isError ? "error" : textOfContent(event.result?.content);
        writePartEnd(write, assistantStream, {
          partId,
          status: event.isError ? "error" : "done",
          result: resultText,
          isError: event.isError,
          preview: toolPreview(resultText),
          message: toolMessage("done", event.toolName, resultText),
        });
        if (assistantStream.activeToolPartId === partId) assistantStream.activeToolPartId = null;
        return;
      }
      case "agent_end":
        closeOpenParts(write, assistantStream, "done");
        return;
      default:
        return;
    }
  });
  unsubscribe.closeOpenParts = (status = "done") => closeOpenParts(write, assistantStream, status);
  return unsubscribe;
}

export function observePromptEvents(session, onEvent) {
  return subscribePromptEventSink(session, { onEvent });
}

export function subscribePromptEvents(session, res, onEvent = null) {
  return subscribePromptEventSink(session, { write: (event) => writeNdjson(res, event), onEvent });
}

function writeAssistantUpdate(write, update, stream, onEvent = null) {
  if (update?.type === "text_delta") {
    if (!stream.activeTextPartId) {
      stream.activeTextPartId = `text:${++stream.nextTextPartId}`;
      writePartStart(write, stream, { type: "part_start", partId: stream.activeTextPartId, kind: "text", status: "running" });
    }
    write?.({ type: "part_delta", partId: stream.activeTextPartId, delta: update.delta });
    return;
  }
  if (update?.type === "thinking_start") {
    endActiveTextPart(write, stream);
    const key = contentKey(update);
    const partId = `thinking:${++stream.nextThinkingPartId}`;
    stream.activeThinkingPartId = partId;
    rememberPart(stream.thinkingParts, key, partId);
    writePartStart(write, stream, { type: "part_start", partId, kind: "thinking", title: "thinking", status: "running" });
    return;
  }
  if (update?.type === "thinking_delta") {
    const partId = partFor(stream.thinkingParts, contentKey(update), stream.activeThinkingPartId);
    if (!partId) return;
    write?.({ type: "part_delta", partId, delta: update.delta ?? update.thinking });
    return;
  }
  if (update?.type === "thinking_end") {
    const key = contentKey(update);
    const partId = partFor(stream.thinkingParts, key, stream.activeThinkingPartId);
    if (!partId) return;
    forgetPart(stream.thinkingParts, key);
    if (stream.activeThinkingPartId === partId) stream.activeThinkingPartId = null;
    writePartEnd(write, stream, { partId, status: "done", content: update.content });
    return;
  }
  if (update?.type === "toolcall_start") {
    endActiveTextPart(write, stream);
    const key = contentKey(update);
    const partId = `toolcall:${++stream.nextToolPartId}`;
    stream.activeToolPartId = partId;
    rememberPart(stream.toolParts, key, partId);
    writePartStart(write, stream, { type: "part_start", partId, kind: "tool", title: "tool call", status: "pending", message: toolMessage("pending", "tool call") });
    return;
  }
  if (update?.type === "toolcall_end" && update.toolCall) {
    const key = contentKey(update);
    const partId = partFor(stream.toolParts, key, stream.activeToolPartId) || toolCallPartId(stream, update.toolCall.id);
    forgetPart(stream.toolParts, key);
    if (stream.activeToolPartId === partId) stream.activeToolPartId = null;
    stream.toolPartsByCallId.set(update.toolCall.id, partId);
    const label = skillLabel(update.toolCall.arguments);
    if (label) onEvent?.("tool", `${label} called`);
    writePartStart(write, stream, { type: "part_start", partId, kind: "tool", title: "tool call", status: "pending" });
    write?.({
      type: "part_update",
      partId,
      status: "pending",
      title: update.toolCall.name,
      preview: toolPreview(update.toolCall.arguments),
      metadata: { toolCallId: update.toolCall.id },
      message: toolMessage("pending", update.toolCall.name, update.toolCall.arguments),
    });
  }
}
