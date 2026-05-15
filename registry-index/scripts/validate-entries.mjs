#!/usr/bin/env node
/**
 * For every entry in index.json, fetch its render-harness.yaml at the
 * pinned SHA and validate it against HarnessConfigSchema.
 *
 * Uses the GitHub raw content URL; works for any public GitHub repo.
 * Other forges can be added by extending `rawUrlFor()`.
 *
 * Exit codes:
 *   0  every entry is valid
 *   1  one or more entries failed validation
 *   2  network / I/O error
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHarnessConfigYaml, parseIndexJson } from "@render-harness/registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(HERE, "..", "index.json");

const text = await readFile(indexPath, "utf8");
const idx = parseIndexJson(text);

let failures = 0;

for (const entry of idx.entries) {
  const url = rawUrlFor(entry.repo, entry.ref, "render-harness.yaml");
  if (!url) {
    process.stderr.write(`[${entry.name}] unsupported repo host: ${entry.repo}\n`);
    failures += 1;
    continue;
  }
  let body;
  try {
    const res = await fetch(url, {
      headers: process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {},
    });
    if (!res.ok) {
      process.stderr.write(`[${entry.name}] ${res.status} ${res.statusText} fetching ${url}\n`);
      failures += 1;
      continue;
    }
    body = await res.text();
  } catch (err) {
    process.stderr.write(
      `[${entry.name}] network error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }

  try {
    const cfg = parseHarnessConfigYaml(body);
    if (cfg.name !== entry.name) {
      process.stderr.write(
        `[${entry.name}] render-harness.yaml#name="${cfg.name}" does not match index name="${entry.name}"\n`,
      );
      failures += 1;
      continue;
    }
    process.stdout.write(`[${entry.name}] ok\n`);
  } catch (err) {
    process.stderr.write(
      `[${entry.name}] schema error:\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    failures += 1;
  }
}

if (failures > 0) {
  process.stderr.write(`\n${failures} entr${failures === 1 ? "y" : "ies"} failed validation.\n`);
  process.exit(1);
}
process.stdout.write(`\nall ${idx.entries.length} entries valid.\n`);

function rawUrlFor(repo, ref, path) {
  // GitHub
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${ref}/${path}`;
  return null;
}
