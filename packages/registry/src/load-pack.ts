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
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  type CapabilityPack,
  assertCapabilityPack,
  type PackContext,
} from "./capability.js";
import type { CapabilityRef } from "./schema.js";

export interface LoadedPack {
  ref: CapabilityRef;
  pack: CapabilityPack;
  /** Absolute path to the pack's resolved entry module. */
  modulePath: string;
}

export interface LoadPacksOpts {
  /**
   * Entry repo root. Used as the base for `require.resolve()` so packs
   * are loaded from the entry's `node_modules` rather than wherever
   * `@render-harness/registry` itself lives.
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

  const require = createRequire(`${opts.entryRoot}/`);
  const out: LoadedPack[] = [];

  for (const ref of refs) {
    const modulePath = require.resolve(ref.pack);
    const moduleUrl = pathToFileURL(modulePath).href;
    const mod = (await import(moduleUrl)) as { default?: unknown } & Record<string, unknown>;
    const exported = mod.default ?? mod;
    const pack = assertCapabilityPack(exported, ref.pack);
    out.push({ ref, pack, modulePath });
  }
  return out;
}

export function makePackContext(loaded: LoadedPack, entryName: string, env: NodeJS.ProcessEnv): PackContext {
  return {
    config: loaded.ref.config ?? {},
    env: (name) => env[name],
    entryName,
  };
}
