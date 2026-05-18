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

import { readFile, mkdir, writeFile } from "node:fs/promises";
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
const HARNESS_VERSION_BUNDLE_PATH = resolve(
  CLI_ROOT,
  "bundled-gallery",
  "harness-version.json",
);

async function main(): Promise<void> {
  const harnessVersionRange = await readWorkspacePackageRange("registry");
  const gallery = await loadGalleryFromSource({ root: HARNESS_ROOT });
  const catalog = await loadCapabilityCatalog(
    resolve(HARNESS_ROOT, "capability-catalog", "index.yaml"),
  );
  const overriddenCatalog = await overrideCatalogVersionsFromWorkspace(catalog, harnessVersionRange);
  await mkdir(dirname(BUNDLE_PATH), { recursive: true });
  await writeFile(BUNDLE_PATH, serializeGallery(gallery), "utf8");
  await writeFile(
    CAPABILITY_CATALOG_BUNDLE_PATH,
    `${JSON.stringify(overriddenCatalog, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    HARNESS_VERSION_BUNDLE_PATH,
    `${JSON.stringify({ harnessVersionRange }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `bundled-gallery: ${gallery.agents.length} agents, ${gallery.capabilities.length} capabilities, harness=${harnessVersionRange} → ${BUNDLE_PATH}\n`,
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

async function readCapabilityPackageRange(packageName: string): Promise<string | null> {
  const tail = packageName.replace(/^@render-harness\//, "");
  try {
    return await readWorkspacePackageRange(`capabilities/${tail}`);
  } catch {
    return null;
  }
}

/**
 * Overrides each catalog entry's `versionRange` and `requiresHarness`
 * with the current workspace values. The catalog YAML in the repo is the
 * authoring surface; the bundled JSON is the deploy surface that ships
 * inside the published CLI tarball.
 */
async function overrideCatalogVersionsFromWorkspace(
  catalog: CapabilityCatalog,
  harnessVersionRange: string,
): Promise<CapabilityCatalog> {
  const capabilities = await Promise.all(
    catalog.capabilities.map(async (entry) => {
      const versionRange = (await readCapabilityPackageRange(entry.package)) ?? entry.versionRange;
      return { ...entry, versionRange, requiresHarness: harnessVersionRange };
    }),
  );
  return { ...catalog, capabilities };
}

main().catch((err) => {
  process.stderr.write(
    `bundle-gallery failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
