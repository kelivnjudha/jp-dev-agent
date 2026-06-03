import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["apps", "packages", "scripts"];
const findings = [];

const checks = [
  {
    pattern: /\b0\.0\.0\.0\b/,
    message: "Local services must not bind to 0.0.0.0.",
  },
  {
    pattern: /nodeIntegration\s*:\s*true/,
    message: "Electron renderer must not enable nodeIntegration.",
  },
  {
    pattern: /contextIsolation\s*:\s*false/,
    message: "Electron renderer must not disable contextIsolation.",
  },
  {
    pattern: /targetUrl|upstreamUrl|proxyUrl/i,
    message: "Review arbitrary upstream/proxy URL handling; open proxy behavior is forbidden.",
    allow: /allowed upstream path allowlist|No arbitrary upstream URL support|reject arbitrary upstream URLs/i,
  },
];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full);
      continue;
    }
    if (full === join("scripts", "lint-security.mjs")) continue;
    if (!/\.(ts|tsx|js|mjs|html|md|json)$/.test(entry)) continue;
    const text = readFileSync(full, "utf8");
    for (const check of checks) {
      if (!check.pattern.test(text)) continue;
      if (check.allow?.test(text)) continue;
      findings.push(`${full}: ${check.message}`);
    }
  }
}

for (const root of roots) {
  try {
    walk(root);
  } catch {
    // Missing optional root.
  }
}

if (findings.length > 0) {
  console.error("Security lint failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Security lint passed.");
