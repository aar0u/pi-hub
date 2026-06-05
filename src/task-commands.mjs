function commandText(text) {
  return String(text || "").trim();
}

export function parseTaskCreateRequest(text) {
  const value = commandText(text);
  const direct = value.match(/^\/schedule\s+([\s\S]+)$/i);
  const natural = value.match(/^(?:建立|创建|新增|添加|create)\s*(?:一个|个)?\s*(?:定时任务|scheduled task|schedule)\s+([\s\S]+)$/i);
  const body = direct?.[1] || natural?.[1];
  if (!body?.trim()) return null;
  return { type: "propose", text: body.trim() };
}

export function parseTaskManagement(text) {
  const value = commandText(text);
  const create = parseTaskCreateRequest(value);
  if (create) return create;

  if (/^\/(tasks|listtasks)\b/i.test(value) || /^(查看|列出)\s*(定时任务|任务)$/i.test(value)) return { type: "list" };

  const confirm = value.match(/^\/(confirm|确认)\s+(\S+)/i) || value.match(/^确认\s*(?:定时任务|任务)?\s+(\S+)/i);
  if (confirm) return { type: "confirm", id: confirm[2] || confirm[1] };

  const enable = value.match(/^\/(enable|启用)\s+(\S+)/i) || value.match(/^启用\s*(?:定时任务|任务)?\s+(\S+)/i);
  if (enable) return { type: "enable", id: enable[2] || enable[1] };

  const disable = value.match(/^\/(disable|停用|暂停)\s+(\S+)/i) || value.match(/^(停用|暂停)\s*(?:定时任务|任务)?\s+(\S+)/i);
  if (disable) return { type: "disable", id: disable[2] || disable[1] };

  const del = value.match(/^\/(delete|del|删除)\s+(\S+)/i) || value.match(/^删除\s*(?:定时任务|任务)?\s+(\S+)/i);
  if (del) return { type: "delete", id: del[2] || del[1] };

  return null;
}

export function telegramPrompt(text) {
  return `${text}\n\n[Telegram constraints: reply concisely in plain text. Avoid Markdown tables and complex rich text unless necessary.]`;
}
