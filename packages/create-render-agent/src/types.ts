import type { ModelSpecInput } from "@render-harness/registry/schema";

/**
 * Inputs that drive the scaffolder. The wizard (prompts.ts) collects these;
 * the generator (generate.ts) consumes them.
 *
 * Two flows share this shape:
 *  - **Single-agent** (default): the wizard collects every field.
 *  - **Bundle**: `bundle` is set and the per-agent fields
 *    (`agentName`, `systemPrompt`, `model`, `runtimes`, `capabilities`,
 *    `templateManifest`, `ui`) are ignored by the generator. The bundle's
 *    `manifest` + `sourceFiles` are materialized verbatim.
 */
export interface Answers {
  /** Absolute or relative path to the directory to create. */
  directory: string;
  /** Agent slug; lands in render-harness.yaml `name` and package.json `name`. */
  agentName: string;
  description: string;
  systemPrompt: string;
  /** Full model spec. Lands verbatim under `shared.model` in render-harness.yaml. */
  model: ModelSpecInput;
  /** ≥1 runtime selections. v1 supports web, cron, worker. */
  runtimes: RuntimeSelection[];
  /** Capability packs to wire into render-harness.yaml. Empty by default. */
  capabilities: CapabilityPick[];
  /**
   * The gallery agent template the user picked, if any. Used by the
   * generator to preserve template-declared fields the wizard does NOT
   * collect (mcpServers, permissions, budget, envSchema, capability
   * config). When null, the generator emits from the wizard answers only.
   *
   * Typed loosely (the registry's HarnessConfig type isn't imported here
   * to keep `types.ts` framework-free); the generator narrows where it
   * uses fields.
   */
  templateManifest: Record<string, unknown> | null;
  /**
   * Set when the user picked a sealed bundle template. The generator
   * detects this and materializes the bundled manifest + source tree
   * verbatim, bypassing the single-agent templating pipeline.
   */
  bundle: BundlePick | null;
  /**
   * When web is selected, mount the operator UI from `@render-harness/ui`
   * via `serveWeb({ ui: { path: "/" } })`. Implies a worker runtime, which is added
   * automatically if not already selected (UI-issued runs are enqueued on
   * a pg-boss queue and need a worker to drain).
   */
  ui: boolean;
  /**
   * Package manager the user ran the wizard with. Detected from
   * `npm_config_user_agent`; defaults to "npm" when undetectable. Used
   * in the generated README and live wizard messages so the commands
   * match the user's actual environment. The package.json scripts
   * themselves are PM-agnostic (concurrently uses the universal
   * `npm:` prefix).
   */
  packageManager: PackageManager;
  /**
   * Absolute path to a local harness checkout, or null. When set:
   *   - Gallery is read from the live `<root>/gallery/` and
   *     `<root>/packages/capabilities/`.
   *   - Scaffolded `package.json` `@render-harness/*` deps become
   *     `link:<root>/packages/<pkg>` so the project can be built and
   *     run today without publishing the harness to npm.
   * When null, the CLI uses its bundled gallery snapshot and the
   * scaffolded `package.json` pins published version ranges.
   */
  harnessRoot: string | null;
  gitInit: boolean;
  installDeps: boolean;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * A sealed-bundle template chosen by the wizard. The manifest is the
 * V2 render-harness.yaml shipped with the gallery entry (verbatim);
 * `sourceFiles` is a map of relative POSIX paths → file contents to
 * write under the scaffolded project root, verbatim. The generator
 * adds runtime entrypoints (`src/web.ts`, `src/worker.ts`,
 * `src/cron.ts`) on top of this map.
 */
export interface BundlePick {
  slug: string;
  manifest: Record<string, unknown>;
  sourceFiles: Record<string, string>;
  runtimeKinds: ReadonlyArray<RuntimeKind | "workflows">;
  capabilities: ReadonlyArray<string>;
}

/**
 * Returns the shell prefix used for invoking package.json scripts under
 * the given package manager. yarn omits the `run` — `yarn dev`, not
 * `yarn run dev`.
 */
export function scriptRunner(pm: PackageManager): string {
  return pm === "yarn" ? "yarn" : `${pm} run`;
}

export type RuntimeSelection =
  | { kind: "web" }
  | { kind: "cron"; schedule: string }
  | { kind: "worker"; queue: string };

export type RuntimeKind = RuntimeSelection["kind"];

export interface CapabilityPick {
  pack: string;
  version?: string;
  config?: Record<string, unknown>;
}

/**
 * Whether the scaffold uses a single `src/main.ts` (one runtime) or
 * per-runtime entries (`src/web.ts`, `src/worker.ts`, `src/cron.ts`).
 */
export function isMultiRuntime(answers: Answers): boolean {
  return answers.runtimes.length > 1;
}

export function entryFileFor(kind: RuntimeKind, multi: boolean): string {
  return multi ? `src/${kind}.ts` : "src/main.ts";
}

export function runtimePackageFor(kind: RuntimeKind): string {
  return `@render-harness/runtime-${kind}`;
}
