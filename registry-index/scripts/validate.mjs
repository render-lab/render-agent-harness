#!/usr/bin/env node
/**
 * Validate index.json against the IndexSchema from @render-harness/registry.
 *
 * Run via `node scripts/validate.mjs`. Exits non-zero with a flat list
 * of issues if anything's malformed.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseIndexJson } from "@render-harness/registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(HERE, "..", "index.json");

const text = await readFile(indexPath, "utf8");
try {
  const parsed = parseIndexJson(text);
  process.stdout.write(`index.json is valid (${parsed.entries.length} entries)\n`);
} catch (err) {
  process.stderr.write(`index.json is invalid:\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
