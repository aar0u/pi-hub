import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

function isInside(base, target) {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function acceptsHtml(req) {
  return req.headers.accept?.includes("text/html") ?? false;
}

export function serveStatic(req, res, pathname, publicDir) {
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  let requested;
  try {
    requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  let publicRoot;
  try {
    publicRoot = realpathSync(publicDir);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Static root unavailable");
    return;
  }

  let filePath = resolve(publicRoot, `.${requested}`);
  if (!isInside(publicRoot, filePath)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      if (extname(filePath) || !acceptsHtml(req)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      filePath = join(publicRoot, "index.html");
    } else {
      filePath = realpathSync(filePath);
      if (!isInside(publicRoot, filePath)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
    }
  } catch {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  const type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
  createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
}
