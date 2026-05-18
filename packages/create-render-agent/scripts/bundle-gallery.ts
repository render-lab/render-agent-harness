#!/usr/bin/env tsx
/**
 * Pre-build snapshotter. Reads the live `gallery/` and
 * `packages/capabilities/*` from the harness repo, resolves them via
 * `loadGalleryFromSource`, and serializes the result into
 * `bundled-gallery/gallery.json` next to the CLI's `dist/`.
 *
 * Why a snapshot:
 *   - The published CLI must work without cloning the harness repo.
 *   - The snapshot is loaded at runtime by `loadGalleryFromBundle`,
 *     which validates against `ResolvedGallerySchema` and re-parses each
 *     entry's manifest against `HarnessConfigSchema`. So a bad snapshot
 *     is loud, not silent.
 *
 * Run from the CLI package root:
 *   pnpm tsx scripts/bundle-gallery.ts
 */

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CapabilityCatalog,
  loadCapabilityCatalog,
} from "@render-harness/registry/capability-index";
import { loadGalleryFromSource, serializeGallery } from "@render-harness/registry/gallery";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, "..");
const HARNESS_ROOT = resolve(CLI_ROOT, "..", "..");
const BUNDLE_PATH = resolve(CLI_ROOT, "bundled-gallery", "gallery.json");
const CAPABILITY_CATALOG_BUNDLE_PATH = resolve(
  CLI_ROOT,
  "bundled-gallery",
  "capability-catalog.json",
);
const HARNESS_VERSION_BUNDLE_PATH = resolve(CLI_ROOT, "bundled-gallery", "harness-version.json");

async function main(): Promise<void> {
  const packageVersions = await readAllHarnessPackageRanges();
  // Anchor the bundle's "harness version" to the most conservative
  // substrate package (`@render-harness/core`). The `harnessVersion`
  // field that lands in scaffolded `render-harness.yaml` declares the
  // minimum harness the project expects; pinning it to `core` keeps
  // the constraint satisfiable whenever core is installed, even when
  // sibling packages (registry, web, wizard) ran ahead on patch bumps.
  const corePackage = "@render-harness/core";
  const harnessVersionRange =
    packageVersions[corePackage] ?? (await readWorkspacePackageRange("core"));

  const gallery = await loadGalleryFromSource({ root: HARNESS_ROOT });
  const catalog = await loadCapabilityCatalog(
    resolve(HARNESS_ROOT, "capability-catalog", "index.yaml"),
  );
  const overriddenCatalog = overrideCatalogVersionsFromWorkspace(
    catalog,
    packageVersions,
    harnessVersionRange,
  );
  await mkdir(dirname(BUNDLE_PATH), { recursive: true });
  await writeFile(BUNDLE_PATH, serializeGallery(gallery), "utf8");
  await writeFile(
    CAPABILITY_CATALOG_BUNDLE_PATH,
    `${JSON.stringify(overriddenCatalog, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    HARNESS_VERSION_BUNDLE_PATH,
    `${JSON.stringify({ harnessVersionRange, packages: packageVersions }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `bundled-gallery: ${gallery.agents.length} agents, ${gallery.capabilities.length} capabilities, harness=${harnessVersionRange} (${Object.keys(packageVersions).length} packages tracked) → ${BUNDLE_PATH}\n`,
  );
}

/**
 * Read `packages/<subdir>/package.json` and return a caret range derived
 * from its `version` field. Used to derive published-version ranges for
 * the scaffolder so the snapshot never drifts from what's on npm.
 */
async function readWorkspacePackageRange(subdir: string): Promise<string> {
  const pkgPath = resolve(HARNESS_ROOT, "packages", subdir, "package.json");
  const text = await readFile(pkgPath, "utf8");
  const json = JSON.parse(text) as { version?: string };
  if (!json.version) throw new Error(`packages/${subdir}/package.json missing "version"`);
  return `^${json.version}`;
}

/**
 * Auto-discover every `@render-harness/*` package in the workspace and
 * read its current published version. Returns a map keyed by the
 * fully-qualified package name (`@render-harness/core`, etc.). Drives
 * the per-package version ranges baked into scaffolded `package.json`
 * deps — replaces the previous behaviour of stamping one range across
 * the whole family, which broke whenever sibling packages drifted onto
 * different patch tracks (e.g. registry@0.2.2 alongside core@0.2.1).
 */
async function readAllHarnessPackageRanges(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const scanRoots = [
    resolve(HARNESS_ROOT, "packages"),
    resolve(HARNESS_ROOT, "packages", "capabilities"),
  ];
  for (const root of scanRoots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgJsonPath = resolve(root, entry, "package.json");
      let text: string;
      try {
        text = await readFile(pkgJsonPath, "utf8");
      } catch {
        continue;
      }
      let parsed: { name?: string; version?: string; private?: boolean };
      try {
        parsed = JSON.parse(text) as { name?: string; version?: string; private?: boolean };
      } catch {
        continue;
      }
      if (!parsed.name || !parsed.version) continue;
      if (!parsed.name.startsWith("@render-harness/")) continue;
      if (parsed.private === true) continue;
      out[parsed.name] = `^${parsed.version}`;
    }
  }
  return out;
}

/**
 * Overrides each catalog entry's `versionRange` and `requiresHarness`
 * with the current workspace values. The catalog YAML in the repo is the
 * authoring surface; the bundled JSON is the deploy surface that ships
 * inside the published CLI tarball.
 */
function overrideCatalogVersionsFromWorkspace(
  catalog: CapabilityCatalog,
  packageVersions: Record<string, string>,
  harnessVersionRange: string,
): CapabilityCatalog {
  const capabilities = catalog.capabilities.map((entry) => {
    const versionRange = packageVersions[entry.package] ?? entry.versionRange;
    return { ...entry, versionRange, requiresHarness: harnessVersionRange };
  });
  return { ...catalog, capabilities };
}

main().catch((err) => {
  process.stderr.write(
    `bundle-gallery failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
