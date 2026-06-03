import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["packages", "apps"];
const testFiles = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full);
    } else if (full.endsWith(".test.js") && full.includes(`${join("dist", "")}`)) {
      testFiles.push(full);
    }
  }
}

for (const root of roots) {
  try {
    walk(root);
  } catch {
    // Optional workspace section with no compiled tests.
  }
}

if (testFiles.length === 0) {
  console.log("No compiled unit tests found.");
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
