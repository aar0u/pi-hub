const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

export function sendError(res, error, status = 500) {
  const httpStatus = error instanceof HttpError ? error.status : status;
  sendJson(res, { error: error instanceof Error ? error.message : String(error) }, httpStatus);
}

export async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buf);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid JSON");
  }
}

export function writeNdjson(res, obj) {
  if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(obj)}\n`);
}
