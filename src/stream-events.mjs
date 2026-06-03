import { textOfContent } from "./session-state.mjs";
import { writeNdjson } from "./http.mjs";

function shortText(value, max = 160) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolMessage(phase, toolName, details) {
  const icon = phase === "done" ? "✓" : phase === "queued" ? "…" : "▶";
  const suffix = details === undefined ? "" : ` ${shortText(details)}`;
  const label = phase === "done" ? "done" : phase === "queued" ? "queued" : "running";
  return `${icon} ${toolName} ${label}${suffix}`;
}

export function subscribePromptEvents(session, res, getState) {
  return session.subscribe((event) => {
    switch (event.type) {
      case "message_start":
        writeNdjson(res, { type: "message_start" });
        return;
      case "message_update":
        writeAssistantUpdate(res, event.assistantMessageEvent);
        return;
      case "tool_execution_start":
        writeNdjson(res, { type: "tool", phase: "running", toolName: event.toolName, message: toolMessage("running", event.toolName, event.args) });
        return;
      case "tool_execution_update":
        writeNdjson(res, { type: "tool", phase: "update", toolName: event.toolName, message: toolMessage("update", event.toolName, textOfContent(event.partialResult?.content)) });
        return;
      case "tool_execution_end":
        writeNdjson(res, {
          type: "tool",
          phase: "done",
          toolName: event.toolName,
          isError: event.isError,
          message: toolMessage("done", event.toolName, event.isError ? "error" : textOfContent(event.result?.content)),
        });
        return;
      case "agent_end":
        writeNdjson(res, { type: "state", state: getState() });
        return;
      default:
        return;
    }
  });
}

function writeAssistantUpdate(res, update) {
  if (update?.type === "text_delta") {
    writeNdjson(res, { type: "delta", delta: update.delta });
    return;
  }
  if (update?.type === "thinking_delta") {
    writeNdjson(res, { type: "delta", delta: update.delta ?? update.thinking });
    return;
  }
  if (update?.type === "toolcall_start") {
    writeNdjson(res, { type: "tool", phase: "queued", message: "… preparing tool call" });
    return;
  }
  if (update?.type === "toolcall_end" && update.toolCall) {
    writeNdjson(res, {
      type: "tool",
      phase: "queued",
      toolName: update.toolCall.name,
      message: toolMessage("queued", update.toolCall.name, update.toolCall.arguments),
    });
  }
}
