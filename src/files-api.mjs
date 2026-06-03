import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { HttpError } from "./http.mjs";

const ignoredFileNames = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".DS_Store"]);

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertPathInCwd(cwd, value) {
  const root = await fs.realpath(resolve(cwd));
  const requested = resolve(root, value || ".");
  let target;
  try {
    target = await fs.realpath(requested);
  } catch {
    throw new HttpError(404, "Directory not found");
  }
  if (!isInside(root, target)) throw new HttpError(403, "Path is outside cwd");
  return { root, target };
}

export async function listFiles(cwd, url) {
  const { root, target: dir } = await assertPathInCwd(cwd, url.searchParams.get("path") || ".");
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new HttpError(404, "Directory not found");
  }

  const rows = await Promise.all(entries
    .filter((entry) => !ignoredFileNames.has(entry.name))
    .map(async (entry) => {
      const fullPath = resolve(dir, entry.name);
      try {
        const stat = await fs.lstat(fullPath);
        return {
          name: entry.name,
          path: fullPath,
          relativePath: relative(root, fullPath) || entry.name,
          isDir: stat.isDirectory(),
          size: stat.isFile() ? stat.size : 0,
          modified: stat.mtime.toISOString(),
        };
      } catch {
        return null;
      }
    }));

  return {
    path: dir,
    relativePath: relative(root, dir),
    parentPath: dir === root ? null : resolve(dir, ".."),
    entries: rows
      .filter(Boolean)
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1))),
  };
}
