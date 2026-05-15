import {
  type AgentDefinition,
  applyMigrations,
  type Budget,
  buildLogger,
  closeSharedKv,
  closeSharedPool,
  createCancelSignal,
  createRun,
  DEFAULT_BUDGET,
  getKv,
  getPool,
  type Logger,
  type RunStepResult,
  runAgent,
  serializeError,
} from "@render-harness/core";

/**
 * Cron runtime: one-shot, run-to-completion semantics for scheduled agents.
 *
 * The cron job process boots, applies migrations, creates a single agent run,
 * runs it to completion, then exits. Render bills cron jobs by the second of
 * runtime, so the entrypoint is intentionally minimal.
 *
 * Constraints honored:
 *   - Render cron caps a single invocation at 12 hours. The cron runtime
 *     defaults its wall budget to 11h (in {@link Budget}) so we exit with a
 *     clean status before the platform forcibly kills us.
 *   - No persistent disk on cron services; all state goes to Postgres.
 *   - Cron services cannot accept inbound private network traffic, so this
 *     runtime never opens a listener.
 *
 * Usage:
 *
 *   import { runCron } from "@render-harness/runtime-cron";
 *   import { citationsAgent } from "./agent.js";
 *
 *   await runCron({
 *     agent: citationsAgent,
 *     metadata: { source: "cron", schedule: "0 13 * * *" },
 *   });
 */
export interface RunCronOpts {
  agent: AgentDefinition;
  /** Optional explicit run id; otherwise a UUID is generated. */
  runId?: string;
  /** User id to associate with the run; null for system-owned cron runs. */
  userId?: string | null;
  /** Free-form metadata persisted on the run row. */
  metadata?: Record<string, unknown>;
  /** Override the default 11h wall budget (still capped by the platform's 12h). */
  budget?: Partial<Budget>;
  /** Optional injected logger; defaults to a pino instance. */
  logger?: Logger;
  /** Skip migrations (already applied externally). */
  skipMigrations?: boolean;
  /** Disable the KV-backed cancel signal (when no KV is configured). */
  disableKvCancel?: boolean;
}

export interface RunCronResult {
  runId: string;
  result: RunStepResult;
  exitCode: number;
}

export async function runCron(opts: RunCronOpts): Promise<RunCronResult> {
  const logger = opts.logger ?? buildLogger({ service: "runtime-cron" });
  const pool = getPool({ applicationName: `cron:${opts.agent.name}` });
  const upstream = new AbortController();

  // Honor SIGTERM gracefully: Render sends it ahead of platform shutdown.
  const sigtermHandler = () => {
    logger.warn("received SIGTERM; signalling cooperative cancel");
    upstream.abort(new Error("SIGTERM"));
  };
  process.once("SIGTERM", sigtermHandler);
  process.once("SIGINT", sigtermHandler);

  let cancelDispose: (() => void) | null = null;
  try {
    if (!opts.skipMigrations) {
      await applyMigrations(pool);
    }

    const runId = opts.runId ?? globalThis.crypto.randomUUID();
    const run = await createRun(pool, {
      id: runId,
      agentName: opts.agent.name,
      agentVersion: opts.agent.version,
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
      metadata: { runtime: "cron", ...(opts.metadata ?? {}) },
    });
    logger.info({ runId: run.id, agent: opts.agent.name }, "cron run started");

    let signal = upstream.signal;
    if (!opts.disableKvCancel) {
      try {
        const kv = getKv();
        const cancel = createCancelSignal({
          runId: run.id,
          upstream: upstream.signal,
          kv,
        });
        signal = cancel.signal;
        cancelDispose = cancel.dispose;
      } catch (err) {
        logger.debug(
          { err: serializeError(err) },
          "no KV configured; falling back to upstream signal only",
        );
      }
    }

    const agentDef: AgentDefinition = {
      ...opts.agent,
      ...(opts.budget
        ? {
            budget: {
              ...DEFAULT_BUDGET,
              ...(opts.agent.budget ?? {}),
              ...opts.budget,
            },
          }
        : {}),
    };

    const result = await runAgent(
      {
        runId: run.id,
        agentDef,
        signal,
        checkpoint: { kind: "run-to-completion" },
      },
      { pool, logger },
    );

    const exitCode = exitCodeFor(result);
    logger.info({ runId: run.id, status: result.status, exitCode }, "cron run finished");
    return { runId: run.id, result, exitCode };
  } finally {
    cancelDispose?.();
    process.off("SIGTERM", sigtermHandler);
    process.off("SIGINT", sigtermHandler);
    await closeSharedKv().catch(() => {});
    await closeSharedPool().catch(() => {});
  }
}

/**
 * Convenience wrapper for "run agent and exit with a status code." Use this
 * as your cron service's main entrypoint when you don't need to do anything
 * after the run.
 */
export async function runCronAndExit(opts: RunCronOpts): Promise<never> {
  try {
    const { exitCode } = await runCron(opts);
    process.exit(exitCode);
  } catch (err) {
    const logger = opts.logger ?? buildLogger({ service: "runtime-cron" });
    logger.fatal({ err: serializeError(err) }, "cron run crashed");
    process.exit(2);
  }
}

/**
 * Multi-agent registry mode: pick an {@link AgentDefinition} from a map
 * by id and run it through {@link runCron}.
 *
 * This is the entrypoint shape used by V2 bundle deployments. The
 * emitted Render Cron service runs a single `dist/cron.js` that
 * resolves every agent in the bundle once (via
 * `defineFromConfig` → `agentsById`), then calls this function with
 * `agentId = process.env.HARNESS_AGENT_ID`. The emitter sets that env
 * var per cron service so each scheduled service picks the right agent.
 *
 * Throws if `agentId` is empty or not in `agents`.
 */
export interface RunCronFromRegistryOpts extends Omit<RunCronOpts, "agent"> {
  agents: Record<string, AgentDefinition>;
  agentId: string;
}

export async function runCronFromRegistry(
  opts: RunCronFromRegistryOpts,
): Promise<RunCronResult> {
  const agent = lookupAgent(opts.agents, opts.agentId);
  const { agents, agentId, ...rest } = opts;
  void agents;
  void agentId;
  return runCron({ ...rest, agent });
}

export async function runCronFromRegistryAndExit(
  opts: RunCronFromRegistryOpts,
): Promise<never> {
  try {
    const { exitCode } = await runCronFromRegistry(opts);
    process.exit(exitCode);
  } catch (err) {
    const logger = opts.logger ?? buildLogger({ service: "runtime-cron" });
    logger.fatal({ err: serializeError(err) }, "cron run crashed");
    process.exit(2);
  }
}

function lookupAgent(
  agents: Record<string, AgentDefinition>,
  agentId: string,
): AgentDefinition {
  if (!agentId) {
    const known = Object.keys(agents).sort().join(", ") || "(none)";
    throw new Error(
      `runCronFromRegistry: agentId is empty. Set HARNESS_AGENT_ID to one of: ${known}.`,
    );
  }
  const agent = agents[agentId];
  if (!agent) {
    const known = Object.keys(agents).sort().join(", ") || "(none)";
    throw new Error(
      `runCronFromRegistry: agent "${agentId}" not found in registry. Known: ${known}.`,
    );
  }
  return agent;
}

function exitCodeFor(result: RunStepResult): number {
  switch (result.status) {
    case "completed":
      return 0;
    case "cancelled":
      return 130;
    case "failed":
      return 1;
    case "paused":
    case "checkpoint":
      // A run-to-completion cron should never produce these. Treat as a soft
      // failure so an alert fires.
      return 3;
  }
}

