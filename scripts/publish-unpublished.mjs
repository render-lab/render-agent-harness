#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const packageJsonPaths = [...packageDirs("packages"), ...packageDirs("packages/capabilities")]
  .map((dir) => join(dir, "package.json"))
  .filter((path) => existsSync(path))
  .sort();

let failures = 0;

for (const packageJsonPath of packageJsonPaths) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (pkg.private) continue;
  if (!pkg.name || !pkg.version) continue;

  const exists = spawnSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--silent"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (exists.status === 0 && exists.stdout.trim() === pkg.version) {
    console.log(`skip ${pkg.name}@${pkg.version} (already published)`);
    continue;
  }

  const cwd = dirname(packageJsonPath);
  console.log(`publish ${pkg.name}@${pkg.version}`);
  const result = spawnSync("pnpm", ["publish", "--access", "public", "--no-git-checks"], {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`publish failed for ${pkg.name} (${relative(process.cwd(), cwd)})`);
    failures += 1;
  }
}

if (failures > 0) process.exit(1);

function packageDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}
