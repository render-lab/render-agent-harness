import {
  type AgentDefinition,
  applyMigrations,
  type Budget,
  buildLogger,
  type CheckpointPolicy,
  type ContentBlock,
  closeSharedKv,
  closeSharedPool,
  createCancelSignal,
  DEFAULT_BUDGET,
  dispatchScheduledNotifications,
  ensureInitialMessage,
  ensureRun,
  getKvSafe,
  getPool,
  getSchedule,
  installShutdownHandlers,
  type Logger,
  listEnabledSchedules,
  type Message,
  nextCronFire,
  type PoolClient,
  type RunStepResult,
  recordScheduleRun,
  runAgent,
  SCHEDULE_NOTIFY_CHANNEL,
  serializeError,
  setRunStatus,
  type ToolCall,
  type ToolResult,
  type UserId,
  updateSchedule,
} from "@render-harness/core";
import { PgBoss, type Job as PgBossJob } from "pg-boss";

/**
 * Worker runtime: long-lived process that consumes run jobs from a pg-boss
 * queue and dispatches each one through `runAgent`.
 *
 * Production-shape runtime for multi-tenant, queue-driven agents:
 *   - Always-on background process (deploy as a Render worker or pserv).
 *   - Postgres-backed queue (no Redis dependency); same DB as state.
 *   - Soft checkpoint policy: yields back to the queue periodically so a
 *     single long run doesn't block other jobs forever.
 *   - Cooperative cancel via KV cancel:{runId} flags.
 *   - SIGTERM stops the worker gracefully and lets in-flight jobs flush.
 *   - Hooks publish onMessage / onToolCall / onToolResult to Postgres
 *     LISTEN/NOTIFY so the web service can SSE-stream them to clients.
 *
 * Two ways to consume: bring your own AgentDefinition resolver, or pass a
 * single agent that handles every job on the queue.
 *
 * Usage:
 *
 *   import { startWorker } from "@render-harness/runtime-worker";
 *   import { supportAgent } from "./agent.js";
 *
 *   await startWorker({
 *     agent: supportAgent,
 *     queue: "support-runs",
 *   });
 */
export interface WorkerOpts {
  /**
   * Either a single AgentDefinition (used for every job) or a function that
   * resolves the right agent per job. Multi-agent worker pserv is the
   * production pattern; single-agent is the simplest shape.
   */
  agent: AgentDefinition | ((job: RunJob) => AgentDefinition | Promise<AgentDefinition>);
  /** pg-boss queue name. Defaults to "agent-runs". */
  queue?: string;
  /** How many jobs the worker processes in parallel. Defaults to 4. */
  concurrency?: number;
  /** Per-job checkpoint policy. Defaults to a soft 25-call / 6000s checkpoint. */
  checkpoint?: CheckpointPolicy;
  /** Per-job budget overrides. */
  budget?: Partial<Budget>;
  /**
   * Fired after every job, with the RunStepResult and the original RunJob.
   * Use this to post replies to a chat channel, send a webhook, etc. Failures
   * here are logged but don't fail the job.
   */
  onJobResult?: (args: {
    job: RunJob;
    result: RunStepResult;
    logger: Logger;
  }) => void | Promise<void>;
  /** Optional logger. */
  logger?: Logger;
  /** Skip migrations on boot. */
  skipMigrations?: boolean;
}

export interface RunJob {
  /** Stable run id (also the agent_runs.id). */
  runId: string;
  /** The agent the job targets. Used by the agent resolver. */
  agentName: string;
  /** Optional tenant/owner id. */
  userId?: UserId;
  /** Initial user content blocks (optional; the run row already exists). */
  initialContent?: ContentBlock[];
  /** Free-form metadata propagated onto the run row. */
  metadata?: Record<string, unknown>;
  /**
   * `tool_use_id`s a human reviewer approved for execution on this job
   * cycle. Threaded straight into `runAgent({ approvedToolCallIds })` so
   * core's `requireApproval` gate lets the listed tools through instead of
   * pausing on them again. Set by `POST /runs/:id/input` when resuming an
   * `awaiting_approval` pause.
   */
  approvedToolCallIds?: string[];
}

export interface WorkerHandle {
  /** Stop the worker; resolves once in-flight jobs finish. */
  stop: () => Promise<void>;
  /** Underlying pg-boss instance, exposed for advanced ops (cancel, schedule, etc.). */
  boss: PgBoss;
  /** The queue name being consumed. */
  queue: string;
}

const DEFAULT_QUEUE = "agent-runs";
const SCHEDULE_QUEUE = "harness-scheduled-runs";

const DEFAULT_CHECKPOINT: CheckpointPolicy = {
  kind: "soft",
  maxToolCalls: 25,
  maxSeconds: 6000,
};

export async function startWorker(opts: WorkerOpts): Promise<WorkerHandle> {
  const logger = opts.logger ?? buildLogger({ service: "runtime-worker" });
  const queue = opts.queue ?? DEFAULT_QUEUE;
  const concurrency = opts.concurrency ?? 4;
  const checkpoint = opts.checkpoint ?? DEFAULT_CHECKPOINT;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("startWorker: DATABASE_URL is required");
  }

  const pool = getPool({ applicationName: "runtime-worker" });
  if (!opts.skipMigrations) {
    // Single-agent boot: pull pack migrations off the agent def directly.
    // Resolver-based multi-agent boot: caller is responsible for either
    // passing a pre-loaded agent for migration collection or running
    // applyMigrations themselves before startWorker and setting
    // skipMigrations: true.
    const packMigrations =
      typeof opts.agent === "function" ? [] : (opts.agent.packMigrations ?? []);
    await applyMigrations(pool, { packMigrations });
  }

  const kv = getKvSafe(logger);

  const boss = new PgBoss(connectionString);
  boss.on("error", (err: Error) => {
    logger.error({ err: err.message }, "pg-boss error");
  });
  await boss.start();
  await boss.createQueue(queue);
  await boss.createQueue(SCHEDULE_QUEUE);
  logger.info({ queue, concurrency }, "runtime-worker started");

  const inflight = new Set<string>();
  const scheduledBoss = boss as unknown as PgBossScheduler;
  const knownScheduleNames = new Set<string>();
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let scheduleListenClient: PoolClient | null = null;

  const handler = async (jobs: PgBossJob<RunJob>[]) => {
    for (const job of jobs) {
      await processJob(job);
    }
  };

  const processJob = async (job: PgBossJob<RunJob>) => {
    const data = job.data;
    inflight.add(job.id);
    const log = logger.child({ jobId: job.id, runId: data.runId, agent: data.agentName });
    const upstream = new AbortController();

    let cancel: ReturnType<typeof createCancelSignal> | null = null;
    try {
      const agentDef = await resolveAgent(opts.agent, data);
      const run = await ensureRun(getPool(), {
        id: data.runId,
        agentName: agentDef.name,
        agentVersion: agentDef.version,
        ...(data.userId !== undefined ? { userId: data.userId } : {}),
        metadata: { runtime: "worker", ...(data.metadata ?? {}) },
      });
      log.info({ runStatus: run.status }, "processing run job");

      let signal = upstream.signal;
      if (kv) {
        cancel = createCancelSignal({ runId: data.runId, upstream: upstream.signal, kv });
        signal = cancel.signal;
      }

      const mergedBudget: Budget = {
        ...DEFAULT_BUDGET,
        ...(agentDef.budget ?? {}),
        ...(opts.budget ?? {}),
      };
      const def: AgentDefinition = { ...agentDef, budget: mergedBudget };

      const result = await runAgent(
        {
          runId: data.runId,
          agentDef: def,
          signal,
          checkpoint,
          hooks: {
            onMessage: (m) => publishHook(pool, data.runId, "message", m, log),
            onToolCall: (t) => publishHook(pool, data.runId, "tool_call", t, log),
            onToolResult: (r) => publishHook(pool, data.runId, "tool_result", r, log),
          },
          ...(data.approvedToolCallIds && data.approvedToolCallIds.length > 0
            ? { approvedToolCallIds: new Set(data.approvedToolCallIds) }
            : {}),
        },
        { pool, logger: log },
      );
      if (opts.onJobResult) {
        try {
          await opts.onJobResult({ job: data, result, logger: log });
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "onJobResult hook errored; ignoring",
          );
        }
      }
      if (data.metadata?.scheduleId && data.userId && isTerminalResult(result)) {
        try {
          await dispatchScheduledNotifications({
            pool,
            runId: data.runId,
            scheduleId: String(data.metadata.scheduleId),
            userId: data.userId,
            operatorUrl: process.env.RENDER_EXTERNAL_URL ?? null,
            logger: log,
          });
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "scheduled notification dispatch errored; ignoring",
          );
        }
      }
      await handleResult(boss, queue, data, result, log);
    } catch (err) {
      const serialized = serializeError(err, "JobError");
      log.error({ err: serialized.message }, "job failed");
      // Reflect the failure in `agent_runs` so the operator UI (and
      // anything else reading run state) sees a terminal status. Without
      // this, a job that throws on its first attempt leaves the row stuck
      // at `running` forever even after pg-boss gives up.
      await setRunStatus(pool, data.runId, "failed", { error: serialized }).catch((updateErr) =>
        log.error(
          { err: updateErr instanceof Error ? updateErr.message : String(updateErr) },
          "failed to mark run as failed",
        ),
      );
      throw err;
    } finally {
      cancel?.dispose();
      inflight.delete(job.id);
    }
  };

  const processScheduledJob = async (data: ScheduledRunJob) => {
    const log = logger.child({ scheduleId: data.scheduleId });
    const schedule = await getSchedule(pool, { id: data.scheduleId });
    if (!schedule?.enabled) {
      log.info("scheduled job skipped; schedule missing or disabled");
      return;
    }
    const agentDef = await resolveAgent(opts.agent, {
      runId: "scheduled-preview",
      agentName: schedule.agentName,
    });
    const firedAt = new Date();
    const runId = await enqueueRun({
      pool,
      boss,
      queue,
      agentName: agentDef.name,
      agentVersion: agentDef.version,
      userId: schedule.userId,
      initialContent: [{ type: "text", text: schedule.input }],
      metadata: { scheduleId: schedule.id, firedAt: firedAt.toISOString(), ...schedule.metadata },
    });
    await recordScheduleRun(pool, { scheduleId: schedule.id, runId, firedAt });
    let nextFireAt: Date | null = null;
    try {
      nextFireAt = nextCronFire(schedule.cronExpr, schedule.timezone);
    } catch {
      nextFireAt = null;
    }
    await updateSchedule(pool, {
      id: schedule.id,
      patch: { lastFiredAt: firedAt, nextFireAt },
    });
    log.info({ runId, agent: agentDef.name }, "scheduled run enqueued");
  };

  const reconcileSchedules = async () => {
    const schedules = await listEnabledSchedules(pool);
    const activeNames = new Set<string>();
    for (const schedule of schedules) {
      const name = scheduleJobName(schedule.id);
      activeNames.add(name);
      await scheduledBoss.schedule(
        name,
        schedule.cronExpr,
        { scheduleId: schedule.id },
        {
          tz: schedule.timezone,
          queue: SCHEDULE_QUEUE,
        },
      );
      knownScheduleNames.add(name);
    }
    for (const name of Array.from(knownScheduleNames)) {
      if (activeNames.has(name)) continue;
      await scheduledBoss.unschedule(name);
      knownScheduleNames.delete(name);
    }
  };

  await boss.work<RunJob>(queue, { batchSize: concurrency, pollingIntervalSeconds: 0.5 }, handler);
  await boss.work<ScheduledRunJob>(
    SCHEDULE_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs) => {
      for (const job of jobs) {
        await processScheduledJob(job.data);
      }
    },
  );

  await reconcileSchedules().catch((err) =>
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "initial schedule reconciliation failed",
    ),
  );
  reconcileTimer = setInterval(() => {
    void reconcileSchedules().catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "schedule reconciliation failed",
      ),
    );
  }, 30_000);

  scheduleListenClient = await pool.connect();
  await scheduleListenClient.query(`LISTEN "${SCHEDULE_NOTIFY_CHANNEL}"`);
  scheduleListenClient.on("notification", () => {
    void reconcileSchedules().catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "schedule reconciliation after notify failed",
      ),
    );
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.warn({ inflight: inflight.size }, "stopping runtime-worker; waiting for inflight jobs");
    try {
      if (reconcileTimer) clearInterval(reconcileTimer);
      const listenClient = scheduleListenClient;
      if (listenClient) {
        await listenClient.query(`UNLISTEN "${SCHEDULE_NOTIFY_CHANNEL}"`).catch(() => {});
        listenClient.release();
        scheduleListenClient = null;
      }
      await boss.stop({ graceful: true, timeout: 30_000 });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "boss.stop errored");
    }
    await closeSharedKv().catch(() => {});
    await closeSharedPool().catch(() => {});
    logger.info("runtime-worker stopped");
  };

  installShutdownHandlers(stop, logger, { service: "runtime-worker" });
  return { stop, boss, queue };
}

/**
 * Convenience wrapper for "run worker forever; exit on signal." Use this as
 * your worker service's main entrypoint.
 */
export async function startWorkerAndWait(opts: WorkerOpts): Promise<never> {
  await startWorker(opts);
  // Keep the event loop alive; the SIGTERM handler will exit the process.
  await new Promise<never>(() => {});
  return undefined as never;
}

interface ScheduledRunJob {
  scheduleId: string;
}

interface PgBossScheduler {
  schedule: (
    name: string,
    cron: string,
    data: ScheduledRunJob,
    options?: { tz?: string; queue?: string },
  ) => Promise<unknown>;
  unschedule: (name: string) => Promise<unknown>;
}

/**
 * Enqueue a run from an external producer (web service, webhook receiver,
 * etc.). Creates the agent_runs row first so callers can immediately stream
 * via /runs/:id/stream while the worker picks the job up.
 *
 * Returns the run id.
 */
export async function enqueueRun(opts: {
  pool: ReturnType<typeof getPool>;
  boss: PgBoss;
  queue?: string;
  agentName: string;
  agentVersion: string;
  userId?: UserId;
  /**
   * Tag the new run as part of this conversation. The loop will load
   * cross-run history and the run will count toward the conversation's
   * rollup. Callers must enforce the sequential-only invariant themselves
   * (the unique partial index on agent_runs will raise an integrity error
   * otherwise — POST /conversations/:id/messages catches this and returns
   * 409).
   */
  conversationId?: string;
  initialContent?: ContentBlock[];
  metadata?: Record<string, unknown>;
  /** Optional fixed run id; otherwise a UUID is generated. */
  runId?: string;
}): Promise<string> {
  const runId = opts.runId ?? globalThis.crypto.randomUUID();
  await ensureRun(opts.pool, {
    id: runId,
    agentName: opts.agentName,
    agentVersion: opts.agentVersion,
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
    metadata: { runtime: "worker", ...(opts.metadata ?? {}) },
  });
  if (opts.initialContent && opts.initialContent.length > 0) {
    await ensureInitialMessage(opts.pool, {
      runId,
      content: opts.initialContent,
      ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
    });
  }
  const job: RunJob = {
    runId,
    agentName: opts.agentName,
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    ...(opts.initialContent ? { initialContent: opts.initialContent } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  await opts.boss.send(opts.queue ?? DEFAULT_QUEUE, job);
  return runId;
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

async function resolveAgent(source: WorkerOpts["agent"], job: RunJob): Promise<AgentDefinition> {
  if (typeof source === "function") return source(job);
  return source;
}

function scheduleJobName(scheduleId: string): string {
  return `harness-sched-${scheduleId}`;
}

function isTerminalResult(result: RunStepResult): boolean {
  return (
    result.status === "completed" || result.status === "failed" || result.status === "cancelled"
  );
}

async function handleResult(
  boss: PgBoss,
  queue: string,
  data: RunJob,
  result: RunStepResult,
  logger: Logger,
): Promise<void> {
  switch (result.status) {
    case "completed":
    case "failed":
    case "cancelled":
      logger.info({ status: result.status }, "run terminal");
      return;
    case "paused":
      logger.info({ reason: result.reason }, "run paused; awaiting external input");
      return;
    case "checkpoint":
      // Soft checkpoint reached; re-enqueue ourselves so other jobs can run
      // and we resume on the next pull. The agent state is already persisted.
      logger.info({ cursor: result.cursor }, "checkpoint; re-enqueueing");
      await boss.send(queue, data);
      return;
  }
}

async function publishHook(
  pool: ReturnType<typeof getPool>,
  runId: string,
  kind: "message" | "tool_call" | "tool_result",
  payload: Message | ToolCall | ToolResult,
  logger: Logger,
): Promise<void> {
  // The core's state writes already publish NOTIFY events with pointers; the
  // hook here is for runtime-specific side effects (audit logs, OTel spans,
  // posting to Slack threads, etc.). Default: log at debug level.
  logger.debug({ kind, payloadId: extractId(payload) }, "hook fired");
  // We intentionally don't double-publish to NOTIFY; repo.ts already does it.
  void pool;
  void runId;
}

function extractId(payload: Message | ToolCall | ToolResult): string {
  if ("id" in payload) return payload.id;
  if ("toolCallId" in payload) return payload.toolCallId;
  return "?";
}

/**
 * Mark a paused run as failed. Helper for callers that want to time-out
 * runs awaiting input.
 */
export async function failPausedRun(runId: string, reason = "timeout"): Promise<void> {
  const pool = getPool();
  await setRunStatus(pool, runId, "failed", {
    error: { name: "PausedRunTimeout", message: reason, code: "paused_timeout" },
  });
}

export type { PgBoss };
