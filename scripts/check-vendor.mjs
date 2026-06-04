import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vendorFiles } from "./vendor-files.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

let failed = false;

for (const [source, target] of vendorFiles) {
  const [sourceContent, targetContent] = await Promise.all([
    readFile(join(root, source)),
    readFile(join(root, target)),
  ]);
  if (digest(sourceContent) !== digest(targetContent)) {
    console.error(`Vendor file is out of sync: ${target}`);
    console.error(`Run: pnpm vendor:update`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("Vendor files are in sync.");
