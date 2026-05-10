import type { Pool } from "pg";
import type { Logger } from "pino";
import type { LocalToolHandler, RunId, SkillMetadata, UserId } from "../types.js";

/**
 * Everything a builtin factory can pull from at registration time.
 *
 * Builtins are constructed once per run by the loop, so anything attached
 * here is stable for the lifetime of one `runAgent` call. Per-run state
 * (e.g. the `todo` builtin's in-memory write-through cache) closes over
 * the context returned from the factory.
 */
export interface BuiltinContext {
  /** Shared Postgres pool — same one the loop uses for state. */
  pool: Pool;
  /** Resolved skill list for the agent. */
  skills: SkillMetadata[];
  /** The run we're about to execute. */
  runId: RunId;
  /** Caller's userId, scoped from the originating request. `null` for cron / unauthenticated. */
  userId: UserId | null;
  /** Agent name — useful for tools that scope by agent (e.g. list_my_runs). */
  agentName: string;
  /** Run-scoped logger. */
  logger: Logger;
  /** Process env (injectable for tests). */
  env: NodeJS.ProcessEnv;
}

/**
 * The result of attempting to register one builtin.
 *
 * `registered: true` means the tool's preconditions were satisfied and the
 * handler is live. `registered: false` carries the reason it was skipped
 * (missing env var, no provider chain matched, etc.) — the loop logs these
 * and surfaces them via `agent_runs.metadata.skippedBuiltins`.
 */
export type BuiltinRegistration =
  | { registered: true; handler: LocalToolHandler }
  | { registered: false; name: string; reason: string };

/**
 * A builtin tool factory. Given a context, decides whether to register
 * itself and returns either a live handler or a skip reason.
 *
 * Factories are pure functions of context. They must NOT mutate the
 * context, throw on missing-env (return a skip instead), or perform
 * network IO at registration time.
 */
export type BuiltinFactory = (ctx: BuiltinContext) => BuiltinRegistration;

export interface SkippedBuiltin {
  name: string;
  reason: string;
}

export interface BuildBuiltinsResult {
  tools: LocalToolHandler[];
  skipped: SkippedBuiltin[];
}
