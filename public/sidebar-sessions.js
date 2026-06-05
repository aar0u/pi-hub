import { compactText, compactUserRequest } from "./ui.js";

function sessionTitleText(text, slashCommands) {
  const compact = compactUserRequest(text || "", slashCommands);
  if (!compact) return text;
  return compactText([compact.command, compact.visibleText].filter(Boolean).join(" "));
}

export function createSessionSidebar({ state, api, $, icon, runAction, refresh, renderState, updateSidebarData }) {
  return async function loadSessions() {
    const sessions = await api("/api/sessions");
    const box = $("sessions");
    box.innerHTML = "";
    const activeSessionPath = state.data?.sessionFile;
    for (const s of sessions) {
      const row = document.createElement("button");
      const isActive = activeSessionPath && s.path === activeSessionPath;
      row.className = `session ${isActive ? "selected" : ""}`;
      if (isActive) row.setAttribute("aria-current", "true");
      row.title = s.firstMessage || s.path;
      const main = document.createElement("span");
      main.className = "session-main";
      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = sessionTitleText(s.name || s.firstMessage, state.slashCommands) || "(empty session)";
      const meta = document.createElement("div");
      meta.className = "session-meta";
      meta.textContent = `${s.messageCount} msg · ${new Date(s.modified).toLocaleString()}`;
      const cwd = document.createElement("div");
      cwd.className = "session-cwd";
      cwd.textContent = s.cwd || "";
      main.append(title, meta, cwd);

      const actions = document.createElement("span");
      actions.className = "session-actions";
      const rename = document.createElement("button");
      rename.className = "rename icon-button";
      rename.title = "Rename session";
      rename.setAttribute("aria-label", "Rename session");
      rename.textContent = "✎";
      rename.onclick = (ev) => {
        ev.stopPropagation();
        void runAction(async () => {
          const name = prompt("Session name", s.name || "");
          if (name === null) return;
          await api("/api/sessions", { method: "PATCH", body: JSON.stringify({ path: s.path, name }) });
          await refresh({ preserveScroll: true });
        }, "Renaming session…");
      };
      const del = document.createElement("button");
      del.className = "delete icon-button";
      del.title = "Delete session";
      del.setAttribute("aria-label", "Delete session");
      del.append(icon("trash"));
      del.onclick = (ev) => {
        ev.stopPropagation();
        void runAction(async () => {
          if (!confirm("Delete this session?")) return;
          await api(`/api/sessions?path=${encodeURIComponent(s.path)}`, { method: "DELETE" });
          await refresh();
        }, "Deleting session…");
      };
      actions.append(rename, del);
      row.append(main, actions);
      row.onclick = () => void runAction(async () => {
        const previousCwd = state.data?.cwd;
        const data = await api("/api/sessions/open", { method: "POST", body: JSON.stringify({ path: s.path }) });
        renderState(data);
        await updateSidebarData({ loadFiles: previousCwd !== data.cwd });
      }, "Opening session…");
      box.append(row);
    }
  };
}
