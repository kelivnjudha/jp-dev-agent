import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const files = ["index.html", "styles.css"];

await mkdir(join(root, "dist", "renderer"), { recursive: true });

for (const file of files) {
  await copyFile(
    join(root, "src", "renderer", file),
    join(root, "dist", "renderer", file),
  );
}

console.log("Renderer static assets copied.");
