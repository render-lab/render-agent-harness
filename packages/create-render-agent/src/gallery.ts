/**
 * Thin wrapper that resolves the gallery the CLI should use and returns
 * a {@link ResolvedGallery}. Resolution order:
 *
 *   1. `--gallery <path>` flag — points at a checkout of the harness repo
 *      (root, not the `gallery/` subdir). Used by contributors iterating
 *      on entries.
 *   2. Bundled snapshot at `<package>/bundled-gallery/gallery.json` — the
 *      default for end users of `npx create-render-agent`.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadGalleryFromBundle,
  loadGalleryFromSource,
  type ResolvedGallery,
} from "@render-harness/registry/gallery";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ResolveGalleryOpts {
  /** Path to a live harness checkout (the repo root, not `gallery/`). */
  liveSourceRoot?: string;
}

export async function resolveGallery(opts: ResolveGalleryOpts = {}): Promise<ResolvedGallery> {
  if (opts.liveSourceRoot) {
    return loadGalleryFromSource({ root: opts.liveSourceRoot });
  }
  const bundlePath = resolveBundlePath();
  return loadGalleryFromBundle({ path: bundlePath });
}

function resolveBundlePath(): string {
  // The CLI's dist/bin.js is at `<pkg>/dist/bin.js`; bundled-gallery lives
  // at `<pkg>/bundled-gallery/gallery.json`. import.meta.url points at
  // dist/bin.js after bundling, or src/gallery.ts when running unbundled.
  const candidates = [
    resolve(HERE, "..", "bundled-gallery", "gallery.json"),
    resolve(HERE, "..", "..", "bundled-gallery", "gallery.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `gallery bundle not found. Looked in: ${candidates.join(", ")}. ` +
      `Did you run \`pnpm prebuild\` or \`pnpm build\` in @create-render-agent?`,
  );
}
