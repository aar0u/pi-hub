import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { readBody, sendJson } from "../http.mjs";
import { assertKnownSessionPath, assertSessionName, listCurrentSessions, listCwds, renameSession } from "../sessions-api.mjs";

export function registerSessionsRoutes(apiRoutes, context) {
  apiRoutes.set("GET /api/sessions", async (_req, res, _url) => {
    sendJson(res, await listCurrentSessions(context.getRuntime()));
  });

  apiRoutes.set("GET /api/cwds", async (_req, res, _url) => {
    sendJson(res, await listCwds([context.getRuntime().cwd]));
  });

  apiRoutes.set("POST /api/sessions/new", async (_req, res, _url) => {
    await context.withRuntimeMutation(() => context.getRuntime().newSession());
    sendJson(res, context.currentState());
  });

  apiRoutes.set("POST /api/sessions/open", async (req, res, _url) => {
    const { path: value } = await readBody(req);
    const path = await assertKnownSessionPath(value);
    await context.withRuntimeMutation(async () => {
      await context.getRuntime().switchSession(path);
      context.setCwd(context.getRuntime().cwd);
    });
    sendJson(res, context.currentState());
  });

  apiRoutes.set("DELETE /api/sessions", async (_req, res, url) => {
    const path = await assertKnownSessionPath(url.searchParams.get("path"));
    await context.withRuntimeMutation(async () => {
      if (resolve(path) === resolve(context.getRuntime().session.sessionFile ?? "")) await context.getRuntime().newSession();
      await fs.rm(path, { force: true });
    });
    sendJson(res, { ok: true, state: context.currentState() });
  });

  apiRoutes.set("PATCH /api/sessions", async (req, res, _url) => {
    const { path: value, name: rawName } = await readBody(req);
    renameSession(await assertKnownSessionPath(value), assertSessionName(rawName), context.getRuntime());
    sendJson(res, { ok: true, state: context.currentState() });
  });
}
