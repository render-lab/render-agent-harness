import {
  type AgentDefinition,
  createConversation,
  findActiveRunForConversation,
  type ListConversationsFilter,
  listConversations,
  loadConversation,
  loadConversationForUser,
  loadConversationMessages,
  loadMessage,
  type Logger,
  type NotifyPayload,
  type Pool,
  STREAM_NOTIFY_CHANNEL,
  type UserId,
} from "@render-harness/core";
import { enqueueRun } from "@render-harness/runtime-worker";
import type { Hono } from "hono";
import { stream } from "hono/streaming";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { serializeConversation, serializeMessage } from "../serializers.js";

export interface ConversationRouteContext {
  pool: Pool;
  boss: PgBoss;
  auth: (req: Request) => Promise<UserId | null>;
  logger: Logger;
  agents: Record<string, AgentDefinition>;
  queue: string;
  connectionString: string;
  pathPrefix: string;
}

interface CreateConversationBody {
  agentName?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

interface SendMessageBody {
  input?: string;
  metadata?: Record<string, unknown>;
}

export function registerConversationRoutes(app: Hono, ctx: ConversationRouteContext): void {
  const { pool, boss, auth, logger, agents, queue, connectionString, pathPrefix } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;

  app.post(r("/conversations"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const body = ((await c.req.json().catch(() => null)) as CreateConversationBody | null) ?? {};
    const agentName = body.agentName ?? c.req.query("agent") ?? Object.keys(agents)[0] ?? "";
    const agent = agents[agentName];
    if (!agent) {
      return c.json({ error: "unknown_agent", message: `no agent named "${agentName}"` }, 400);
    }
    const conv = await createConversation(pool, {
      userId,
      agentName: agent.name,
      agentVersion: agent.version,
      ...(body.title ? { title: body.title } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
    });
    logger.info({ conversationId: conv.id, agent: agent.name, userId }, "conversation created");
    return c.json({ conversation: serializeConversation(conv) }, 201);
  });

  app.get(r("/conversations"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const url = new URL(c.req.url);
    const agentNames = url.searchParams.getAll("agent").filter((s) => s.length > 0);
    const limit = clampLimitParam(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const allUsers = url.searchParams.get("allUsers") === "1";

    const filter: ListConversationsFilter = {
      ...(agentNames.length > 0 ? { agentName: agentNames } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
    };
    if (!allUsers) filter.userId = userId;

    const page = await listConversations(pool, filter);
    return c.json({
      conversations: page.conversations.map(serializeConversation),
      nextCursor: page.nextCursor,
    });
  });

  app.get(r("/conversations/:id"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const conv = await loadConversationForUser(pool, id, userId);
    if (!conv) return c.json({ error: "not_found" }, 404);
    const messages = await loadConversationMessages(pool, id);
    return c.json({
      conversation: serializeConversation(conv),
      messages: messages.map(serializeMessage),
    });
  });

  app.post(r("/conversations/:id/messages"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const conv = await loadConversationForUser(pool, id, userId);
    if (!conv) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => null)) as SendMessageBody | null;
    if (!body?.input || typeof body.input !== "string" || body.input.trim() === "") {
      return c.json(
        { error: "invalid_input", message: "body.input must be a non-empty string" },
        400,
      );
    }

    // Sequential-only: bounce the request if a prior turn is still in
    // flight. The DB has a unique partial index that would also catch this
    // — we check first so the caller gets a structured 409 instead of an
    // opaque integrity error if the worker happened to finish between the
    // check and the insert.
    const active = await findActiveRunForConversation(pool, id);
    if (active) {
      return c.json(
        {
          error: "conversation_busy",
          message: "a prior turn is still in flight",
          activeRunId: active.id,
          status: active.status,
        },
        409,
      );
    }

    const agent = agents[conv.agentName];
    if (!agent) {
      // The conversation was created under an agent that's no longer
      // loaded by this web service. Surface it cleanly rather than letting
      // enqueueRun fail with a less obvious error.
      return c.json(
        {
          error: "unknown_agent",
          message: `conversation belongs to agent "${conv.agentName}" which is not loaded`,
        },
        409,
      );
    }

    try {
      const runId = await enqueueRun({
        pool,
        boss,
        queue,
        agentName: agent.name,
        agentVersion: agent.version,
        userId,
        conversationId: id,
        initialContent: [{ type: "text", text: body.input }],
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });
      logger.info(
        { runId, conversationId: id, agent: agent.name, userId },
        "conversation turn enqueued",
      );
      return c.json({ conversationId: id, runId, status: "pending" }, 202);
    } catch (err) {
      // Race: another producer slipped in between findActiveRun and
      // ensureRun and the unique partial index fired. Map to 409 for a
      // consistent client contract.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("agent_runs_conversation_active_uq")) {
        return c.json(
          { error: "conversation_busy", message: "another turn started concurrently" },
          409,
        );
      }
      throw err;
    }
  });

  app.get(r("/conversations/:id/stream"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const conv = await loadConversationForUser(pool, id, userId);
    if (!conv) return c.json({ error: "not_found" }, 404);

    c.header("content-type", "text/event-stream; charset=utf-8");
    c.header("cache-control", "no-cache, no-transform");
    c.header("connection", "keep-alive");
    c.header("x-accel-buffering", "no");

    return stream(c, async (s) => {
      const writeEvent = (event: string, data: unknown) =>
        s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Replay the whole conversation up front so a fresh subscriber gets a
      // coherent view without having to also call GET /conversations/:id.
      const replay = await loadConversationMessages(pool, id);
      for (const m of replay) {
        await writeEvent("message", serializeMessage(m));
      }

      // Unlike a single-run stream, a conversation stream stays open across
      // run boundaries. The client closes the EventSource when it's done; we
      // also bail if the request is aborted.
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
          if (parsed.conversationId !== id) return;
          if (parsed.kind === "message") {
            const m = await loadMessage(pool, parsed.messageId);
            if (m) await writeEvent("message", serializeMessage(m));
          } else if (parsed.kind === "run_status") {
            // Forward the per-run status. A terminal status on one run does
            // NOT close the conversation stream — the next user message
            // enqueues a fresh run that pushes more events down the same
            // channel.
            await writeEvent("status", { runId: parsed.runId, status: parsed.status });
          } else if (parsed.kind === "run_created") {
            await writeEvent("run_created", { runId: parsed.runId });
          }
        });

        c.req.raw.signal.addEventListener("abort", () => resolveDone?.(), { once: true });

        await done;
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
}

function clampLimitParam(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return undefined;
  if (n < 1) return 1;
  if (n > 200) return 200;
  return n;
}

// Re-export so callers can opt to use a different fetcher in tests without
// importing pg directly.
export { loadConversation };
