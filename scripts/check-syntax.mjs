import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "public", "scripts"];
const extensions = new Set([".js", ".mjs"]);

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      files.push(path);
    }
  }

  return files;
}

const files = (await Promise.all(roots.map(collectFiles))).flat();
const result = spawnSync(process.execPath, ["--check", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
