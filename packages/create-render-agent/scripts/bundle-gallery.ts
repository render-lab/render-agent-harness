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

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGalleryFromSource, serializeGallery } from "@render-harness/registry/gallery";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, "..");
const HARNESS_ROOT = resolve(CLI_ROOT, "..", "..");
const BUNDLE_PATH = resolve(CLI_ROOT, "bundled-gallery", "gallery.json");

async function main(): Promise<void> {
  const gallery = await loadGalleryFromSource({ root: HARNESS_ROOT });
  await mkdir(dirname(BUNDLE_PATH), { recursive: true });
  await writeFile(BUNDLE_PATH, serializeGallery(gallery), "utf8");
  process.stdout.write(
    `bundled-gallery: ${gallery.agents.length} agents, ${gallery.capabilities.length} capabilities → ${BUNDLE_PATH}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `bundle-gallery failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
