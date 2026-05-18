/**
 * Resolves the `@render-harness/*` version ranges scaffolded projects
 * should depend on when {@link Answers.harnessRoot} is null (the default
 * `npx create-render-agent` flow).
 *
 * The bundle is built by `scripts/bundle-gallery.ts` from the live
 * workspace immediately before the CLI is packaged. Per-package
 * versions are written into `bundled-gallery/harness-version.json`
 * along with a top-level `harnessVersionRange` anchor (pinned to
 * `@render-harness/core`, the most conservative substrate package).
 *
 * Why per-package rather than one universal range:
 *   The `@render-harness/*` family does not move in lockstep. Patch
 *   bumps to `registry` or `web` cascade ahead of `core`/`contracts`/
 *   `runtime-*` (see AGENTS.md). Stamping one range across every dep
 *   produced `package.json` files that requested versions no published
 *   tarball satisfied (`^0.2.2` for `@render-harness/core` while npm
 *   only had `0.2.1`).
 *
 * Resolution order:
 *
 *   1. `bundled-gallery/harness-version.json` — written by the prebuild
 *      script from the current workspace state. This always reflects
 *      the latest workspace versions in dev and the versions pnpm
 *      publishes the CLI with in production.
 *   2. `create-render-agent/package.json`'s own dependency on
 *      `@render-harness/registry`. Pnpm rewrites `workspace:*` to a
 *      real version range at publish time. Best-effort only — applies
 *      to every dep, since this fallback predates the per-package map.
 *   3. Hardcoded last-resort fallback. Should never be reached.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));

interface BundledHarnessVersions {
  harnessVersionRange?: string;
  packages?: Record<string, string>;
}

function readBundledHarnessVersions(): BundledHarnessVersions | null {
  // src/version-ranges.ts → ../bundled-gallery/...
  // dist/version-ranges.js → ../bundled-gallery/...
  const candidates = [
    resolve(HERE, "..", "bundled-gallery", "harness-version.json"),
    resolve(HERE, "..", "..", "bundled-gallery", "harness-version.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const json = JSON.parse(readFileSync(path, "utf8")) as BundledHarnessVersions;
      if (json.harnessVersionRange || json.packages) return json;
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

const BUNDLED = readBundledHarnessVersions();
const FALLBACK_RANGE = readPackageJsonRegistryDep() ?? "^0.2.0";

/**
 * Anchor range used for `render-harness.yaml`'s `harnessVersion`
 * field. Tracks `@render-harness/core` — the lowest-common range that
 * the registry's mixed-version check accepts when the family drifts
 * across patch tracks.
 */
export const DEFAULT_HARNESS_VERSION_RANGE: string =
  BUNDLED?.harnessVersionRange ?? FALLBACK_RANGE;

/**
 * Returns the version range to stamp into a scaffolded `package.json`
 * for the given `@render-harness/*` package. Looks up the per-package
 * map written into the bundle by `scripts/bundle-gallery.ts`. Falls
 * back to {@link DEFAULT_HARNESS_VERSION_RANGE} for packages not present
 * in the bundle (e.g. a newer harness package added after the CLI was
 * published).
 */
export function harnessVersionRangeFor(pkgName: string): string {
  const explicit = BUNDLED?.packages?.[pkgName];
  if (explicit) return explicit;
  return DEFAULT_HARNESS_VERSION_RANGE;
}
