import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["apps", "packages", "docs", "scripts"];
const findings = [];
const patterns = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\b(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
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
    if (!/\.(ts|tsx|js|mjs|html|md|json)$/.test(entry)) continue;
    const text = readFileSync(full, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        findings.push(full);
        break;
      }
    }
  }
}

for (const root of roots) {
  try {
    walk(root);
  } catch {
    // Optional root.
  }
}

if (findings.length > 0) {
  console.error("Potential secret material found:");
  for (const file of findings) console.error(`- ${file}`);
  process.exit(1);
}

console.log("Secret scan passed.");
