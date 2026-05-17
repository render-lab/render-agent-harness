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
  type CapabilityCatalog,
  loadCapabilityCatalog,
} from "@render-harness/registry/capability-index";
import {
  loadGalleryFromBundle,
  loadGalleryFromSource,
  type ResolvedCapabilityEntry,
  type ResolvedGallery,
} from "@render-harness/registry/gallery";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ResolveGalleryOpts {
  /** Path to a live harness checkout (the repo root, not `gallery/`). */
  liveSourceRoot?: string;
  /** Optional capability catalog path. Defaults to live/bundled catalog when available. */
  capabilityCatalogPath?: string;
}

export async function resolveGallery(opts: ResolveGalleryOpts = {}): Promise<ResolvedGallery> {
  let gallery: ResolvedGallery;
  if (opts.liveSourceRoot) {
    gallery = await loadGalleryFromSource({ root: opts.liveSourceRoot });
  } else {
    gallery = await loadGalleryFromBundle({ path: resolveBundlePath("gallery.json") });
  }
  const catalog = await resolveCapabilityCatalog(opts);
  return catalog ? enrichGalleryCapabilities(gallery, catalog) : gallery;
}

export function enrichGalleryCapabilities(
  gallery: ResolvedGallery,
  catalog: CapabilityCatalog,
): ResolvedGallery {
  const byPackage = new Map(catalog.capabilities.map((entry) => [entry.package, entry]));
  const seen = new Set<string>();
  const capabilities: ResolvedCapabilityEntry[] = gallery.capabilities.map((cap) => {
    seen.add(cap.pack);
    const entry = byPackage.get(cap.pack);
    if (!entry) return cap;
    const envHint = entry.envVars.map((env) => env.name).join(", ") || cap.envHint;
    return {
      pack: cap.pack,
      label: entry.name,
      description: entry.description,
      envHint,
    };
  });
  for (const entry of catalog.capabilities) {
    if (seen.has(entry.package)) continue;
    capabilities.push({
      pack: entry.package,
      label: entry.name,
      description: entry.description,
      envHint: entry.envVars.map((env) => env.name).join(", ") || null,
    });
  }
  return { ...gallery, capabilities };
}

async function resolveCapabilityCatalog(
  opts: ResolveGalleryOpts,
): Promise<CapabilityCatalog | null> {
  const candidates = [
    opts.capabilityCatalogPath,
    opts.liveSourceRoot
      ? resolve(opts.liveSourceRoot, "capability-catalog", "index.yaml")
      : undefined,
    !opts.liveSourceRoot ? resolveBundlePath("capability-catalog.json", false) : undefined,
  ].filter((p): p is string => !!p);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    return loadCapabilityCatalog(path);
  }
  return null;
}

function resolveBundlePath(fileName: string, required = true): string {
  // The CLI's dist/bin.js is at `<pkg>/dist/bin.js`; bundled-gallery lives
  // at `<pkg>/bundled-gallery/*.json`. import.meta.url points at
  // dist/bin.js after bundling, or src/gallery.ts when running unbundled.
  const candidates = [
    resolve(HERE, "..", "bundled-gallery", fileName),
    resolve(HERE, "..", "..", "bundled-gallery", fileName),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  if (!required) return candidates[0] ?? fileName;
  throw new Error(
    `gallery bundle not found. Looked in: ${candidates.join(", ")}. ` +
      `Did you run \`pnpm prebuild\` or \`pnpm build\` in @create-render-agent?`,
  );
}
