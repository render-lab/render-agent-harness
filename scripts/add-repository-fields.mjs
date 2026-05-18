#!/usr/bin/env node
/**
 * One-shot maintenance: stamp a `repository` field on every publishable
 * workspace package.json that's missing one. npm's Trusted Publishing
 * documentation requires `repository.url` to exactly match the GitHub
 * repository the OIDC token comes from, otherwise the publish PUT can
 * be rejected (E422 / ENEEDAUTH).
 *
 *   node scripts/add-repository-fields.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_URL = "git+https://github.com/render-lab/render-agent-harness.git";

const packageDirs = [...listDirs("packages"), ...listDirs("packages/capabilities")];

let touched = 0;
for (const dir of packageDirs) {
  const path = join(dir, "package.json");
  if (!existsSync(path)) continue;
  const text = readFileSync(path, "utf8");
  const pkg = JSON.parse(text);
  if (pkg.private) continue;
  if (pkg.repository) continue;
  pkg.repository = {
    type: "git",
    url: REPO_URL,
    directory: dir,
  };
  // Preserve trailing newline; JSON.stringify drops it.
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
