import {
  type AgentDefinition,
  appendMessage,
  type ContentBlock,
  getKvSafe,
  type ListRunsFilter,
  type Logger,
  listMessages,
  listRuns,
  listToolCalls,
  loadMessage,
  loadRunForUser,
  type NotifyPayload,
  type Pool,
  type RunStatus,
  requestCancel,
  STREAM_NOTIFY_CHANNEL,
  setRunStatus,
  type UserId,
} from "@render-harness/core";
import { enqueueRun } from "@render-harness/runtime-worker";
import type { Hono } from "hono";
import { stream } from "hono/streaming";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { serializeMessage, serializeRun } from "../serializers.js";

export interface RunRouteContext {
  pool: Pool;
  boss: PgBoss;
  auth: (req: Request) => Promise<UserId | null>;
  logger: Logger;
  agents: Record<string, AgentDefinition>;
  queue: string;
  connectionString: string;
  pathPrefix: string;
}

interface RunCreateBody {
  input: string;
  agentName?: string;
  metadata?: Record<string, unknown>;
}

const VALID_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export function registerRunRoutes(app: Hono, ctx: RunRouteContext): void {
  const { pool, boss, auth, logger, agents, queue, connectionString, pathPrefix } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;

  app.post(r("/runs"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => null)) as RunCreateBody | null;
    if (!body || typeof body.input !== "string" || body.input.trim() === "") {
      return c.json(
        { error: "invalid_input", message: "body.input must be a non-empty string" },
        400,
      );
    }
    const agentName = body.agentName ?? c.req.query("agent") ?? Object.keys(agents)[0] ?? "";
    const agent = agents[agentName];
    if (!agent) {
      return c.json({ error: "unknown_agent", message: `no agent named "${agentName}"` }, 400);
    }
    const runId = await enqueueRun({
      pool,
      boss,
      queue,
      agentName: agent.name,
      agentVersion: agent.version,
      userId,
      initialContent: [{ type: "text", text: body.input }],
      ...(body.metadata ? { metadata: body.metadata } : {}),
    });
    logger.info({ runId, agent: agent.name, userId }, "run enqueued");
    return c.json({ runId, status: "pending" }, 202);
  });

  app.get(r("/runs"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const url = new URL(c.req.url);
    const statuses = parseStatuses(url.searchParams.getAll("status"));
    const agentNames = url.searchParams.getAll("agent").filter((s) => s.length > 0);
    const limit = clampLimitParam(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    // Default to only-my-runs unless the caller opts into all-users, which
    // an operator with a shared bearer key may want.
    const allUsers = url.searchParams.get("allUsers") === "1";

    const filter: ListRunsFilter = {
      ...(statuses.length > 0 ? { status: statuses } : {}),
      ...(agentNames.length > 0 ? { agentName: agentNames } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
    };
    if (!allUsers) filter.userId = userId;

    const page = await listRuns(pool, filter);
    return c.json({
      runs: page.runs.map(serializeRun),
      nextCursor: page.nextCursor,
    });
  });

  // Convenience for the chat UI: returns the caller's most recent
  // non-terminal run for an agent so the Chat tab can rehydrate the
  // current session on page load. Returns `{ run: null }` (200) when
  // no active run exists, so the client can branch without treating
  // 404s as errors.
  app.get(r("/runs/active"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const url = new URL(c.req.url);
    const agentName = url.searchParams.get("agent");
    const filter: ListRunsFilter = {
      userId,
      status: ["pending", "running", "paused"],
      limit: 1,
    };
    if (agentName && agentName.length > 0) filter.agentName = [agentName];
    const page = await listRuns(pool, filter);
    const run = page.runs[0];
    return c.json({ run: run ? serializeRun(run) : null });
  });

  app.get(r("/runs/:id"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const run = await loadRunForUser(pool, id, userId);
    if (!run) return c.json({ error: "not_found" }, 404);
    const messages = await listMessages(pool, id);
    return c.json({ run, messages });
  });

  app.get(r("/runs/:id/tool-calls"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const run = await loadRunForUser(pool, id, userId);
    if (!run) return c.json({ error: "not_found" }, 404);
    const calls = await listToolCalls(pool, id);
    return c.json({
      toolCalls: calls.map((entry) => ({
        id: entry.call.id,
        name: entry.call.name,
        input: entry.call.input,
        status: entry.call.status,
        idempotencyKey: entry.call.idempotencyKey,
        createdAt: entry.call.createdAt.toISOString(),
        startedAt: entry.call.startedAt?.toISOString() ?? null,
        finishedAt: entry.call.finishedAt?.toISOString() ?? null,
        result: entry.result
          ? {
              content: entry.result.content,
              truncatedContent: entry.result.truncatedContent,
              tokenCount: entry.result.tokenCount,
              isError: entry.result.isError,
              durationMs: entry.result.durationMs,
              createdAt: entry.result.createdAt.toISOString(),
            }
          : null,
      })),
    });
  });

  app.get(r("/runs/:id/stream"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const run = await loadRunForUser(pool, id, userId);
    if (!run) return c.json({ error: "not_found" }, 404);

    // Standard SSE headers. Without `text/event-stream` the browser's
    // EventSource aborts the connection — the chat would replay history
    // on each navigation but never see live updates.
    c.header("content-type", "text/event-stream; charset=utf-8");
    c.header("cache-control", "no-cache, no-transform");
    c.header("connection", "keep-alive");
    // Disable proxy buffering (nginx, GCP Load Balancer, etc.) so events
    // reach the client immediately rather than getting batched.
    c.header("x-accel-buffering", "no");

    return stream(c, async (s) => {
      const writeEvent = (event: string, data: unknown) =>
        s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Replay everything that's already happened.
      const replay = await listMessages(pool, id);
      for (const m of replay) {
        await writeEvent("message", serializeMessage(m));
      }
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        await writeEvent("done", { status: run.status });
        return;
      }

      // Tail NOTIFY for new events. Use a dedicated pg client so a long-running
      // LISTEN doesn't tie up the shared pool.
      const listenClient = new pg.Client({ connectionString });
      await listenClient.connect();
      try {
        await listenClient.query(`LISTEN "${STREAM_NOTIFY_CHANNEL}"`);
        let resolveDone: (() => void) | null = null;
        const done = new Promise<void>((res) => {
          resolveDone = res;
        });

        listenClient.on("notification", async (msg: pg.Notification) => {
          if (!msg.payload) return;
          let parsed: NotifyPayload;
          try {
            parsed = JSON.parse(msg.payload) as NotifyPayload;
          } catch {
            return;
          }
          if (parsed.runId !== id) return;
          if (parsed.kind === "message") {
            const m = await loadMessage(pool, parsed.messageId);
            if (m) await writeEvent("message", serializeMessage(m));
          } else if (parsed.kind === "run_status") {
            await writeEvent("status", { status: parsed.status });
            if (
              parsed.status === "completed" ||
              parsed.status === "failed" ||
              parsed.status === "cancelled"
            ) {
              resolveDone?.();
            }
          }
        });

        c.req.raw.signal.addEventListener("abort", () => resolveDone?.(), { once: true });

        await done;
        await writeEvent("done", { runId: id });
      } finally {
        try {
          await listenClient.query(`UNLISTEN "${STREAM_NOTIFY_CHANNEL}"`);
        } catch {
          // ignore
        }
        await listenClient.end().catch(() => {});
      }
    });
  });

  app.post(r("/runs/:id/cancel"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const run = await loadRunForUser(pool, id, userId);
    if (!run) return c.json({ error: "not_found" }, 404);

    // Already terminal — nothing to cancel.
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return c.json({
        runId: id,
        cancelRequested: false,
        status: run.status,
        message: "run is already terminal",
      });
    }

    // A `paused` run is parked waiting on HITL input — `ask_user` or an
    // approval gate. There's no worker process currently running to
    // observe a KV flag, so just flip the DB status directly. We *also*
    // set the KV flag for symmetry — a producer racing to re-enqueue
    // would still see the cancel.
    if (run.status === "paused") {
      await setRunStatus(pool, id, "cancelled");
      const kv = getKvSafe(logger);
      if (kv) await requestCancel(kv, id, "web_request");
      logger.info({ runId: id, userId, prevStatus: run.status }, "cancel applied to paused run");
      return c.json({ runId: id, cancelRequested: true, status: "cancelled" });
    }

    // Run is `pending` or `running` — the worker is (or will be) executing.
    // Write the KV flag; the cancel signal in `runtime-worker` polls it
    // between turns and tool calls and aborts the in-flight model call.
    const kv = getKvSafe(logger);
    if (!kv) {
      return c.json({ error: "cancel_unavailable", message: "no KV configured" }, 503);
    }
    await requestCancel(kv, id, "web_request");
    logger.info({ runId: id, userId }, "cancel requested");
    return c.json({ runId: id, cancelRequested: true, status: run.status });
  });

  /**
   * HITL input. Injects a user message into a `paused` run and re-enqueues
   * it. The only thing that puts a run into `paused` is human-in-the-loop:
   * `ask_user` (awaiting_input) or `permissions.requireApproval`
   * (awaiting_approval). Chat-turn-end is *not* a pause reason — multi-turn
   * chat is driven by POST /conversations/:id/messages.
   */
  app.post(r("/runs/:id/input"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const run = await loadRunForUser(pool, id, userId);
    if (!run) return c.json({ error: "not_found" }, 404);
    if (run.status !== "paused") {
      return c.json(
        { error: "not_paused", status: run.status, message: "run is not awaiting input" },
        409,
      );
    }
    const body = (await c.req.json().catch(() => null)) as { input?: string } | null;
    if (!body?.input || typeof body.input !== "string") {
      return c.json({ error: "invalid_input" }, 400);
    }
    const content: ContentBlock[] = [{ type: "text", text: body.input }];
    await appendMessage(pool, {
      runId: id,
      ...(run.conversationId ? { conversationId: run.conversationId } : {}),
      role: "user",
      content,
    });
    await setRunStatus(pool, id, "pending");
    await boss.send(queue, {
      runId: id,
      agentName: run.agentName,
      ...(run.userId ? { userId: run.userId } : {}),
    });
    logger.info({ runId: id, userId }, "HITL input injected; run re-enqueued");
    return c.json({ runId: id, status: "pending" });
  });
}

function parseStatuses(raw: string[]): RunStatus[] {
  const out: RunStatus[] = [];
  for (const s of raw) {
    if (VALID_RUN_STATUSES.has(s as RunStatus)) out.push(s as RunStatus);
  }
  return out;
}

function clampLimitParam(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return undefined;
  if (n < 1) return 1;
  if (n > 200) return 200;
  return n;
}
