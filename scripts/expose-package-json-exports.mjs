#!/usr/bin/env node
/**
 * One-shot maintenance: make every publishable workspace package expose
 * its `package.json` through the `exports` map. Without this, modern
 * Node refuses `require("<pkg>/package.json")` when the package has an
 * `exports` field — which is exactly the lookup `@render-harness/registry`'s
 * `readPackageVersion` does to detect running harness versions.
 *
 *   node scripts/expose-package-json-exports.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const packageDirs = [...listDirs("packages"), ...listDirs("packages/capabilities")];

let touched = 0;
for (const dir of packageDirs) {
  const path = join(dir, "package.json");
  if (!existsSync(path)) continue;
  const text = readFileSync(path, "utf8");
  const pkg = JSON.parse(text);
  if (pkg.private) continue;
  if (!pkg.exports) continue;
  if (pkg.exports["./package.json"]) continue;
  pkg.exports = { ...pkg.exports, "./package.json": "./package.json" };
  const next = `${JSON.stringify(pkg, null, 2)}\n`;
  if (next !== text) {
    writeFileSync(path, next, "utf8");
    touched += 1;
    process.stdout.write(`updated ${path}\n`);
  }
}
process.stdout.write(`done — ${touched} package.json files updated\n`);

function listDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}
