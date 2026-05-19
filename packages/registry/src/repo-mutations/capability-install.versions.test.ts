/**
 * Regression test for the catalog-vs-workspace version drift that bit
 * us at the 0.7.0 cut: every `versionRange` in
 * OFFICIAL_CAPABILITY_INSTALLS is a hardcoded literal, and bumping the
 * harness's coordinated minor without also bumping these literals
 * silently pins every freshly-installed capability to the old minor
 * line. The harness's runtime version check then red-banners the
 * harness because cap@0.X is incompatible with core@0.Y.
 *
 * This test walks `packages/capabilities/*\/package.json` from the
 * repo root, looks up each pack's current `version`, and asserts that
 * the catalog's `versionRange` is `^<major.minor.0>` for that version.
 * Failure means someone bumped the workspace cap without updating
 * this map (or vice versa) — fix the literal to match.
 *
 * Packs in the catalog that don't exist in the workspace (none today,
 * but theoretically possible if we ever ship a third-party catalog
 * entry) are skipped — the test only enforces consistency between the
 * map and the workspace it ships from.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { OFFICIAL_CAPABILITY_INSTALLS } from "./capability-install.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = packages/registry/src/repo-mutations
// repo root is four levels up.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const CAPS_DIR = join(REPO_ROOT, "packages", "capabilities");

function readWorkspaceCapVersions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dirName of readdirSync(CAPS_DIR)) {
    const pkgPath = join(CAPS_DIR, dirName, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (typeof pkg.name === "string" && typeof pkg.version === "string") {
        out.set(pkg.name, pkg.version);
      }
    } catch {
      // Missing or malformed package.json — not a real cap dir, skip.
    }
  }
  return out;
}

function caretMinorFor(version: string): string {
  // `^0.7.0` for any 0.7.x; `^1.2.3` for 1.x. The minor-line caret is
  // what we ship in package.json for sibling first-party deps.
  const parts = version.split(".");
  if (parts.length < 3) throw new Error(`unexpected version shape: ${version}`);
  if (parts[0] === "0") {
    // semver-zero: any minor bump is breaking, so the caret pins to
    // the minor line.
    return `^${parts[0]}.${parts[1]}.0`;
  }
  return `^${parts[0]}.0.0`;
}

describe("OFFICIAL_CAPABILITY_INSTALLS version ranges", () => {
  const workspaceVersions = readWorkspaceCapVersions();

  it("matches every workspace cap's current major.minor.0 line", () => {
    const mismatches: string[] = [];
    for (const [pack, entry] of Object.entries(OFFICIAL_CAPABILITY_INSTALLS)) {
      const workspaceVersion = workspaceVersions.get(pack);
      if (!workspaceVersion) continue; // third-party entry, not enforced
      const expected = caretMinorFor(workspaceVersion);
      if (entry.versionRange !== expected) {
        mismatches.push(
          `${pack}: catalog says ${entry.versionRange}, workspace is ${workspaceVersion} (expected ${expected})`,
        );
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `OFFICIAL_CAPABILITY_INSTALLS version drift:\n  ${mismatches.join("\n  ")}\n\nFix: edit packages/registry/src/repo-mutations/capability-install.ts to use the expected ranges. This bumps must happen alongside every coordinated minor cut — installing a stale-versionRange cap pins the harness's new cap dep to the old minor line and trips the runtime version check.`,
      );
    }
  });

  it("covers every published workspace cap (catches accidentally dropped entries)", () => {
    const missing: string[] = [];
    for (const [pack] of workspaceVersions) {
      if (!OFFICIAL_CAPABILITY_INSTALLS[pack]) missing.push(pack);
    }
    if (missing.length > 0) {
      throw new Error(
        `OFFICIAL_CAPABILITY_INSTALLS is missing entries for these workspace caps:\n  ${missing.join("\n  ")}\n\nFix: add an entry to packages/registry/src/repo-mutations/capability-install.ts so the Install capability modal can list them. Without this, the operator UI can't install the pack.`,
      );
    }
  });
});
