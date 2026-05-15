/**
 * Capability pack loader.
 *
 * Packs are regular npm packages. They get installed in the entry's
 * `node_modules` via `pnpm add`, listed in `capabilities[]` in
 * render-harness.yaml, and dynamic-imported here.
 *
 * We resolve packs against the entry repo's directory rather than the
 * registry package's directory, because the registry package itself
 * does not depend on any pack — the entry does.
 *
 * **Resolution strategy.** Pack packages are ESM (the harness is
 * `"type": "module"` end-to-end) and many of them export only the
 * `import` condition in `package.json#exports`. Node's CJS resolver
 * (`createRequire().resolve`) doesn't honor `import` and falls through
 * to "No exports main defined" — which is what bit us locally. Instead
 * of forcing every pack to add a `default` fallback (CJS-friendly), we
 * read the pack's `package.json` directly, walk `exports["."]` for the
 * `import` condition (with sensible fallbacks), and dynamic-import the
 * resolved file path.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertCapabilityPack, type CapabilityPack, type PackContext } from "./capability.js";
import type { CapabilityRef } from "./schema.js";

export interface LoadedPack {
  ref: CapabilityRef;
  pack: CapabilityPack;
  /** Absolute path to the pack's resolved entry module. */
  modulePath: string;
}

export interface LoadPacksOpts {
  /**
   * Entry repo root. Used as the base for pack resolution — packs are
   * read from `<entryRoot>/node_modules/<pack-name>/`. pnpm `link:`
   * deps work transparently because Node follows the symlink before
   * reading `package.json`.
   */
  entryRoot: string;
  /** capabilities[] block from render-harness.yaml. Empty / undefined returns []. */
  refs?: CapabilityRef[];
}

/**
 * Load every capability pack referenced by an entry's render-harness.yaml.
 * Returns the loaded packs in declaration order.
 */
export async function loadPacks(opts: LoadPacksOpts): Promise<LoadedPack[]> {
  const refs = opts.refs ?? [];
  if (refs.length === 0) return [];

  const out: LoadedPack[] = [];
  for (const ref of refs) {
    const modulePath = await resolvePackEntry(opts.entryRoot, ref.pack);
    const moduleUrl = pathToFileURL(modulePath).href;
    const mod = (await import(moduleUrl)) as { default?: unknown } & Record<string, unknown>;
    const exported = mod.default ?? mod;
    const pack = assertCapabilityPack(exported, ref.pack);
    out.push({ ref, pack, modulePath });
  }
  return out;
}

interface PackageJsonShape {
  main?: string;
  module?: string;
  exports?:
    | string
    | {
        [key: string]: string | { import?: string; default?: string; node?: string };
      };
}

/**
 * Resolve a pack's entry-point absolute path by reading its
 * `package.json` directly. Prefers `exports["."].import` (the ESM
 * condition), falls back to `exports["."].default`, then `module`,
 * then `main`, finally `./index.js`. Skips Node's built-in CJS
 * resolver entirely so ESM-only packages (no `default`/`require`
 * conditions) still load.
 */
async function resolvePackEntry(entryRoot: string, pkgName: string): Promise<string> {
  const pkgDir = resolve(entryRoot, "node_modules", pkgName);
  const pkgJsonPath = resolve(pkgDir, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgJsonPath, "utf8");
  } catch (err) {
    throw new Error(
      `capability pack "${pkgName}" not found at ${pkgJsonPath} (entryRoot=${entryRoot}). Did you \`pnpm install\` after adding it to render-harness.yaml capabilities?`,
      { cause: err },
    );
  }
  const pkg = JSON.parse(raw) as PackageJsonShape;

  let rel: string | undefined;
  const exportsField = pkg.exports;
  if (typeof exportsField === "string") {
    rel = exportsField;
  } else if (exportsField && typeof exportsField === "object") {
    const dot = exportsField["."];
    if (typeof dot === "string") {
      rel = dot;
    } else if (dot && typeof dot === "object") {
      rel = dot.import ?? dot.node ?? dot.default;
    }
  }
  rel = rel ?? pkg.module ?? pkg.main ?? "index.js";
  return resolve(pkgDir, rel);
}

export function makePackContext(
  loaded: LoadedPack,
  entryName: string,
  env: NodeJS.ProcessEnv,
): PackContext {
  return {
    config: loaded.ref.config ?? {},
    env: (name) => env[name],
    entryName,
  };
}
