/**
 * Helpers the agent-add route uses to keep a managed harness's
 * `src/<kind>.ts` runtime entry files and `tsup.config.ts` entry map
 * aligned with what the freshly emitted `render.yaml` actually
 * references.
 *
 * The Blueprint emitter generates start commands like `node
 * dist/cron.js` whenever a manifest has multiple agents with a cron
 * runtime. If the project's tsup config doesn't have a matching `cron:
 * "src/cron.ts"` entry — or the source file doesn't exist — the build
 * "succeeds" (tsup silently skips), `dist/cron.js` never lands, and
 * the cron service crashes at start with `Cannot find module
 * dist/cron.js`. The same applies symmetrically to web / worker /
 * cron-trigger / workflows entries.
 *
 * Two pure helpers:
 *
 *   - `requiredEntries(cfg)` — mirrors the emitter's naming logic
 *     (`buildNaming` in `@render-harness/registry`'s emitter) and
 *     reports every `dist/<X>.js` the emitter will reference, paired
 *     with the source path and a template body for the file. The
 *     synthetic `main` entry — used by single-runtime scaffolds — is
 *     deliberately *not* reported here. We never auto-write `src/main.ts`
 *     because that's the user's hand-authored single-runtime entry,
 *     and the emitter only points at `dist/main.js` in scenarios where
 *     the project already shipped one.
 *
 *   - `ensureTsupEntries(text, required)` — additive string-rewrite of
 *     `tsup.config.ts`'s `entry: { ... }` block. Adds missing entries,
 *     never removes existing ones (so a single-runtime project with
 *     `{ main: "src/main.ts" }` becomes `{ main: "src/main.ts", cron:
 *     "src/cron.ts" }` rather than losing the main entry). When the
 *     entry block can't be located the call is a no-op and the caller
 *     surfaces a warning.
 */

import type { HarnessConfig, RuntimeBlockInput } from "@render-harness/registry";
import { workflowTaskAgents } from "@render-harness/registry";
import {
  bundleCronEntry,
  bundleCronTriggerEntry,
  bundleWebEntry,
  bundleWorkerEntry,
  bundleWorkflowsEntry,
} from "create-render-agent";

export interface RequiredEntry {
  /** Entry key in tsup config — also the dist file's basename. */
  name: string;
  /** Repo-relative source path the tsup entry points at. */
  sourcePath: string;
  /** Template body to write when the source file is missing. */
  template: () => string;
}

type WebRt = Extract<RuntimeBlockInput, { kind: "web" }>;
type WorkerRt = Extract<RuntimeBlockInput, { kind: "worker" }>;
type CronRt = Extract<RuntimeBlockInput, { kind: "cron" }>;

interface Buckets {
  web: WebRt[];
  worker: WorkerRt[];
  cron: CronRt[];
}

function bucketByKind(cfg: HarnessConfig): Buckets {
  const buckets: Buckets = { web: [], worker: [], cron: [] };
  for (const agent of cfg.agents) {
    for (const rt of agent.runtimes) {
      if (rt.kind === "web") buckets.web.push(rt);
      else if (rt.kind === "worker") buckets.worker.push(rt);
      else if (rt.kind === "cron") buckets.cron.push(rt);
    }
  }
  return buckets;
}

function isSingleAgent(cfg: HarnessConfig): boolean {
  return cfg.agents.length === 1 && cfg.agents[0]?.id === cfg.name;
}

export function requiredEntries(cfg: HarnessConfig): RequiredEntry[] {
  const buckets = bucketByKind(cfg);
  const isMultiTenantWeb = buckets.web.length > 0 && buckets.worker.length > 0;
  const singleAgent = isSingleAgent(cfg);

  const entries = new Map<string, RequiredEntry>();
  const add = (name: string, template: () => string) => {
    if (!entries.has(name)) {
      entries.set(name, { name, sourcePath: `src/${name}.ts`, template });
    }
  };

  // Web: emitter uses webShellService (dist/web.js) when any worker is
  // present, otherwise syncWebService (dist/main.js — never templated).
  if (buckets.web.length > 0 && isMultiTenantWeb) {
    add("web", bundleWebEntry);
  }
  if (buckets.worker.length > 0) {
    add("worker", bundleWorkerEntry);
  }
  for (const rt of buckets.cron) {
    if (rt.via === "workflow") {
      add("cron-trigger", bundleCronTriggerEntry);
    } else if (!singleAgent) {
      // Single-agent cron uses dist/main.js (the scaffold's pre-existing
      // entry); never template that one.
      add("cron", bundleCronEntry);
    }
  }
  if (workflowTaskAgents(cfg).length > 0) {
    add("workflows", bundleWorkflowsEntry);
  }
  return [...entries.values()];
}

export interface EnsureTsupEntriesResult {
  /** The updated tsup.config.ts text. */
  text: string;
  /** True when the text actually changed (entries were appended). */
  changed: boolean;
  /**
   * False when the entry block couldn't be located in the file. The
   * caller surfaces a warning in that case so the user knows to fix
   * tsup manually rather than discovering it via a crashing service.
   */
  patched: boolean;
}

/**
 * Append every entry in `required` that isn't already present in the
 * tsup config's `entry: { ... }` block. Preserves existing entries
 * verbatim.
 */
export function ensureTsupEntries(
  text: string,
  required: ReadonlyArray<string>,
): EnsureTsupEntriesResult {
  if (required.length === 0) return { text, changed: false, patched: true };

  // Match `entry: { ... }` allowing whitespace/newlines inside the
  // braces. We don't try to handle a `defineConfig([{...}, {...}])`
  // multi-config form — scaffolded tsup.config.ts files always use the
  // single-config shape. If a custom tsup config doesn't match, the
  // caller surfaces a warning and the user fixes it by hand.
  const re = /(\bentry\s*:\s*\{)([^}]*)(\})/;
  const match = re.exec(text);
  if (!match) return { text, changed: false, patched: false };
  const prefix = match[1] ?? "";
  const inner = match[2] ?? "";
  const suffix = match[3] ?? "";

  // Collect existing entry keys. The regex tolerates bare or
  // quoted keys (`web:` vs `"web":` vs `'web':`).
  const existing = new Set(
    [...inner.matchAll(/(["']?)([A-Za-z_][\w-]*)\1\s*:\s*["']/g)]
      .map((m) => m[2])
      .filter((s): s is string => Boolean(s)),
  );
  const missing = required.filter((name) => !existing.has(name));
  if (missing.length === 0) return { text, changed: false, patched: true };

  const isMultiLine = inner.includes("\n");
  let nextInner: string;
  if (isMultiLine) {
    // Detect indent of existing entries (or fall back to 4 spaces).
    const indentMatch = inner.match(/\n([ \t]+)\S/);
    const indent = indentMatch?.[1] ?? "    ";
    // Detect closing-brace indent — the `}` typically sits one level
    // out from the entry rows.
    const closeIndentMatch = inner.match(/\n([ \t]*)$/);
    const closeIndent = closeIndentMatch?.[1] ?? indent.replace(/[ \t]{2}$/, "");
    const trimmedRight = inner.replace(/\s+$/, "");
    const sep = trimmedRight.endsWith(",") || trimmedRight === "" ? "" : ",";
    const additions = missing
      .map((name) => `${indent}${JSON.stringify(name)}: ${JSON.stringify(`src/${name}.ts`)},`)
      .join("\n");
    nextInner = `${trimmedRight}${sep}\n${additions}\n${closeIndent}`;
  } else {
    const trimmed = inner.trim();
    const additions = missing
      .map((name) => `${JSON.stringify(name)}: ${JSON.stringify(`src/${name}.ts`)}`)
      .join(", ");
    if (trimmed === "") {
      nextInner = ` ${additions} `;
    } else {
      const sep = trimmed.endsWith(",") ? " " : ", ";
      nextInner = ` ${trimmed}${sep}${additions} `;
    }
  }

  return {
    text: text.replace(re, `${prefix}${nextInner}${suffix}`),
    changed: true,
    patched: true,
  };
}
