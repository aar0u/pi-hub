import { sendJson } from "../http.mjs";
import { listFiles } from "../files-api.mjs";

export function registerFilesRoutes(apiRoutes, context) {
  apiRoutes.set("GET /api/files", async (_req, res, url) => {
    sendJson(res, await listFiles(context.getCwd(), url));
  });
}
