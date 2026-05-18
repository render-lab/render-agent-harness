/**
 * Resolves the `@render-harness/*` version range scaffolded projects
 * should depend on when {@link Answers.harnessRoot} is null (the default
 * `npx create-render-agent` flow).
 *
 * Resolution order:
 *
 *   1. `bundled-gallery/harness-version.json` — written by the prebuild
 *      script from the current `packages/registry/package.json` version.
 *      This always reflects the latest workspace state in dev, and the
 *      version pnpm publishes the CLI with in production.
 *   2. `create-render-agent/package.json`'s own dependency on
 *      `@render-harness/registry`. Pnpm rewrites `workspace:*` to a real
 *      version range at publish time, so this is correct in the
 *      published tarball but is `workspace:*` in dev.
 *   3. Hardcoded last-resort fallback. Should never be reached.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));

function readBundledHarnessVersion(): string | null {
  // src/version-ranges.ts → ../bundled-gallery/...
  // dist/version-ranges.js → ../bundled-gallery/...
  const candidates = [
    resolve(HERE, "..", "bundled-gallery", "harness-version.json"),
    resolve(HERE, "..", "..", "bundled-gallery", "harness-version.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const json = JSON.parse(readFileSync(path, "utf8")) as { harnessVersionRange?: string };
      if (json.harnessVersionRange) return json.harnessVersionRange;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function readPackageJsonRegistryDep(): string | null {
  const range = pkg.dependencies["@render-harness/registry"];
  if (typeof range !== "string") return null;
  if (range === "workspace:*" || range.startsWith("workspace:")) return null;
  return range;
}

export const DEFAULT_HARNESS_VERSION_RANGE: string =
  readBundledHarnessVersion() ?? readPackageJsonRegistryDep() ?? "^0.2.0";
