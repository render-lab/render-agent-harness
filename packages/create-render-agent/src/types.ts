/**
 * Inputs that drive the scaffolder. The wizard (prompts.ts) collects these;
 * the generator (generate.ts) consumes them.
 */
export interface Answers {
  /** Absolute or relative path to the directory to create. */
  directory: string;
  /** Agent slug; lands in render-harness.yaml `name` and package.json `name`. */
  agentName: string;
  description: string;
  systemPrompt: string;
  /** Model ID, e.g. `claude-sonnet-4-6`. */
  model: string;
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
   * When web is selected, mount the operator UI from `@render-harness/ui`
   * via `serveWeb({ ui: true })`. Implies a worker runtime, which is added
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
  gitInit: boolean;
  installDeps: boolean;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

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
