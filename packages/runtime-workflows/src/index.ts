import {
  type AgentDefinition,
  appendMessage,
  applyMigrations,
  type Budget,
  buildLogger,
  type CheckpointPolicy,
  type ContentBlock,
  createCancelSignal,
  createRun,
  DEFAULT_BUDGET,
  getKv,
  getPool,
  type Logger,
  loadRun,
  type Pool,
  type RunStepResult,
  runAgent,
  type UserId,
} from "@render-harness/core";

/**
 * Workflows runtime: each agent step is one Render Workflows task.
 *
 * The deployment shape is:
 *
 *   1. The agent's task is registered in a Render Workflow service via
 *      `task({ name }, async (input) => { ... })` from
 *      `@renderinc/sdk/workflows` (see deploy-agent example main.ts).
 *   2. External callers (a web service, a CLI, another workflow) start the
 *      task via `triggerAgentWorkflow()`, which uses the Render REST SDK to
 *      call `render.workflows.runTask(...)`.
 *   3. Inside the registered task, call {@link runAgentStep} to do one
 *      checkpoint's worth of agent work. If it returns
 *      `{ status: "checkpoint" }`, the user task self-recurses (chained
 *      subtask) so each checkpoint shows up as its own line in the
 *      Workflows UI.
 *   4. On `{ status: "paused", reason: "awaiting_approval" }`, the task
 *      returns. A subsequent trigger with `approvedToolCallIds` resumes.
 *
 * Why this shape: Workflow tasks are stateless and time-bounded (default
 * 7200s per task). Splitting an agent into per-checkpoint tasks gives us
 * durability across deploys, individual retry policies per step, and a
 * useful Workflows UI timeline. State lives in Postgres exactly as the
 * other runtimes (cron, web, worker) — Workflows owns "what happened
 * orchestration-wise"; Postgres owns "what the work produced."
 *
 * NOTE: as of build, Render Workflows are not supported in render.yaml
 * Blueprints. The Workflow service must be created in the Dashboard. See
 * examples/deploy-agent/README.md for the deploy checklist.
 */

export interface RunAgentStepOpts {
  agent: AgentDefinition;
  runId: string;
  /**
   * Initial user content blocks. Only used on the first step (when the run
   * has no messages yet); ignored on subsequent steps.
   */
  initialContent?: ContentBlock[];
  /** Tenant id to scope the run to. */
  userId?: UserId;
  /** Run metadata persisted on the agent_runs row. */
  metadata?: Record<string, unknown>;
  /**
   * Tool-use ids the operator has approved for execution. Forwarded to
   * runAgent so the loop can resume past `awaiting_approval` for those ids.
   */
  approvedToolCallIds?: ReadonlyArray<string>;
  /**
   * Per-step checkpoint policy. Defaults to a soft 25-call / 6000s
   * checkpoint, which fits inside Render Workflows' default 7200s task
   * timeout with margin.
   */
  checkpoint?: CheckpointPolicy;
  /** Per-step budget overrides. */
  budget?: Partial<Budget>;
  /** Logger; defaults to a pino instance scoped to "runtime-workflows". */
  logger?: Logger;
  /** Skip migrations on entry. Set when the workflow runner already ran them. */
  skipMigrations?: boolean;
}

/**
 * Run one checkpoint's worth of an agent. The caller (the Workflows task
 * function) decides what to do with the result:
 *
 *   - `completed` / `failed` / `cancelled`: return the result to the
 *     workflow, the run is over.
 *   - `paused`: return the result; the workflow shows the pause reason and
 *     payload. A subsequent trigger with `approvedToolCallIds` resumes.
 *   - `checkpoint`: chain another invocation of the same task. The simplest
 *     pattern is `return await stepTask(input)` from inside your `task(...)`
 *     callback; that becomes a subtask in the Workflows UI.
 */
export async function runAgentStep(opts: RunAgentStepOpts): Promise<RunStepResult> {
  const logger = opts.logger ?? buildLogger({ service: "runtime-workflows" });
  const log = logger.child({ runId: opts.runId, agent: opts.agent.name });

  const pool = getPool({ applicationName: `workflows:${opts.agent.name}` });
  if (!opts.skipMigrations) {
    await applyMigrations(pool);
  }

  await ensureRunExists({ pool, opts });
  await ensureInitialContent({ pool, opts, logger: log });

  const upstream = new AbortController();
  let cancel: ReturnType<typeof createCancelSignal> | null = null;
  let signal = upstream.signal;
  try {
    const kv = tryGetKv(log);
    if (kv) {
      cancel = createCancelSignal({
        runId: opts.runId,
        upstream: upstream.signal,
        kv,
      });
      signal = cancel.signal;
    }

    const mergedBudget: Budget = {
      ...DEFAULT_BUDGET,
      ...(opts.agent.budget ?? {}),
      ...(opts.budget ?? {}),
    };
    const def: AgentDefinition = { ...opts.agent, budget: mergedBudget };

    const result = await runAgent(
      {
        runId: opts.runId,
        agentDef: def,
        signal,
        checkpoint: opts.checkpoint ?? DEFAULT_WORKFLOW_CHECKPOINT,
        ...(opts.approvedToolCallIds && opts.approvedToolCallIds.length > 0
          ? { approvedToolCallIds: new Set(opts.approvedToolCallIds) }
          : {}),
      },
      { pool, logger: log },
    );
    log.info(
      {
        status: result.status,
        ...(result.status === "paused" ? { reason: result.reason } : {}),
      },
      "agent step done",
    );
    return result;
  } finally {
    cancel?.dispose();
  }
}

const DEFAULT_WORKFLOW_CHECKPOINT: CheckpointPolicy = {
  kind: "soft",
  maxToolCalls: 25,
  maxSeconds: 6000,
};

// --------------------------------------------------------------------
// Trigger helper (client side)
// --------------------------------------------------------------------

/**
 * Start a workflow run that drives an agent. Imported lazily so consumers
 * that only need {@link runAgentStep} don't pull the SDK client.
 *
 * Set `RENDER_API_KEY` in the calling environment so the SDK can authenticate.
 *
 * The `taskRef` is the qualified task identifier shown on the task's page in
 * the Render Dashboard, e.g. `"deploy-agent/agent-step"`.
 */
export interface TriggerOpts {
  /** `<workflow-slug>/<task-name>` identifier. */
  taskRef: string;
  /** Stable run id; the agent_runs row gets created with this id. */
  runId?: string;
  /** Required for `agent_runs.agent_name` if we need to create the row. */
  agentName: string;
  /** Required for `agent_runs.agent_version`. */
  agentVersion: string;
  userId?: UserId;
  initialContent?: ContentBlock[];
  metadata?: Record<string, unknown>;
  /** Tool-use ids approved for this resume. */
  approvedToolCallIds?: ReadonlyArray<string>;
  /** Wait for the task to finish; default false (fire-and-forget). */
  await?: boolean;
}

export interface TriggerResult {
  runId: string;
  taskRunId: string;
  status?: string;
  results?: unknown;
}

export async function triggerAgentWorkflow(opts: TriggerOpts): Promise<TriggerResult> {
  // Ensure the agent_runs row exists so the workflow task can immediately
  // load it. Lets the producer / consumer races go away (the task body never
  // has to "wait for the row to exist").
  const runId = opts.runId ?? globalThis.crypto.randomUUID();
  const pool = getPool({ applicationName: "trigger-workflow" });
  await applyMigrations(pool);
  const existing = await loadRun(pool, runId);
  if (!existing) {
    await createRun(pool, {
      id: runId,
      agentName: opts.agentName,
      agentVersion: opts.agentVersion,
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
      metadata: { runtime: "workflows", ...(opts.metadata ?? {}) },
    });
  }
  if (opts.initialContent && opts.initialContent.length > 0) {
    const messageCount = await countRunMessages(pool, runId);
    if (messageCount === 0) {
      await appendMessage(pool, {
        runId,
        role: "user",
        content: opts.initialContent,
      });
    }
  }

  const { Render } = await import("@renderinc/sdk");
  const render = new Render();

  const taskInput = {
    runId,
    ...(opts.approvedToolCallIds && opts.approvedToolCallIds.length > 0
      ? { approvedToolCallIds: [...opts.approvedToolCallIds] }
      : {}),
  };

  if (opts.await) {
    const r = await render.workflows.runTask(opts.taskRef, [taskInput]);
    return {
      runId,
      taskRunId: r.id,
      status: r.status,
      results: r.results,
    };
  }
  const started = await render.workflows.startTask(opts.taskRef, [taskInput]);
  return { runId, taskRunId: started.taskRunId };
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

async function ensureRunExists(args: { pool: Pool; opts: RunAgentStepOpts }) {
  const existing = await loadRun(args.pool, args.opts.runId);
  if (existing) return;
  await createRun(args.pool, {
    id: args.opts.runId,
    agentName: args.opts.agent.name,
    agentVersion: args.opts.agent.version,
    ...(args.opts.userId !== undefined ? { userId: args.opts.userId } : {}),
    metadata: { runtime: "workflows", ...(args.opts.metadata ?? {}) },
  });
}

async function ensureInitialContent(args: { pool: Pool; opts: RunAgentStepOpts; logger: Logger }) {
  if (!args.opts.initialContent || args.opts.initialContent.length === 0) return;
  const count = await countRunMessages(args.pool, args.opts.runId);
  if (count > 0) {
    args.logger.debug({ count }, "run already has messages; skipping initialContent");
    return;
  }
  await appendMessage(args.pool, {
    runId: args.opts.runId,
    role: "user",
    content: args.opts.initialContent,
  });
}

async function countRunMessages(pool: Pool, runId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM agent_messages WHERE run_id = $1",
    [runId],
  );
  return Number(rows[0]?.count ?? 0);
}

function tryGetKv(logger: Logger): ReturnType<typeof getKv> | null {
  try {
    return getKv();
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "no KV configured; cancel polling disabled",
    );
    return null;
  }
}

// Re-export commonly-needed types so deploy-agent/main.ts imports stay tight.
export type { ContentBlock, RunStepResult };
