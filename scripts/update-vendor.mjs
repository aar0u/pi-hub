import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vendorFiles } from "./vendor-files.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await mkdir(join(root, "public/vendor"), { recursive: true });

for (const [source, target] of vendorFiles) {
  await mkdir(dirname(join(root, target)), { recursive: true });
  await copyFile(join(root, source), join(root, target));
  console.log(`${source} -> ${target}`);
}
