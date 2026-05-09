import { type ServerType, serve } from "@hono/node-server";
import {
  type AgentDefinition,
  appendMessage,
  applyMigrations,
  buildLogger,
  type ContentBlock,
  closeSharedPool,
  getKv,
  getPool,
  type Logger,
  listMessages,
  loadRunForUser,
  type NotifyPayload,
  type Pool,
  requestCancel,
  STREAM_NOTIFY_CHANNEL,
  setRunStatus,
  type UserId,
} from "@render-harness/core";
import { enqueueRun } from "@render-harness/runtime-worker";
import { type Context, Hono } from "hono";
import { stream } from "hono/streaming";
import pg from "pg";
import { PgBoss } from "pg-boss";

/**
 * Multi-tenant public HTTP service. Sits in front of `runtime-worker` and
 * is the canonical "Phase 3 production shape" web entrypoint.
 *
 * Endpoints (all under the optional path prefix):
 *
 *   POST /runs              — enqueue a new run; returns runId immediately.
 *   GET  /runs/:id          — fetch run row + full message history.
 *   GET  /runs/:id/stream   — Server-Sent Events stream of messages, tool
 *                              calls, and tool results, fed by Postgres
 *                              LISTEN/NOTIFY pointers.
 *   POST /runs/:id/cancel   — write KV cancel flag; the worker observes it
 *                              between turns and tool calls and aborts
 *                              cooperatively.
 *   POST /runs/:id/input    — inject a user message into a paused run and
 *                              re-enqueue it. HITL endpoint.
 *   GET  /healthz           — liveness probe.
 *
 * Auth is API-key bearer by default. Set `auth: undefined` to disable (NOT
 * recommended for a public deployment); pass an async function for custom
 * auth that pulls the userId from a JWT, session cookie, or anything else.
 *
 * For demo / single-tenant / sub-30s shapes use `@render-harness/runtime-web`
 * instead; this package assumes a queue + worker exist.
 */
export interface ServeWebOpts {
  /**
   * The agent(s) the producer can enqueue. If you have one agent, pass it
   * directly. Multi-agent deployments pass an `agents` map and require a
   * `?agent=` query string or `agentName` in the body.
   */
  agent?: AgentDefinition;
  agents?: Record<string, AgentDefinition>;
  /** TCP port. Defaults to PORT env or 8080. */
  port?: number;
  hostname?: string;
  /** pg-boss queue name. Must match the worker's. Defaults to "agent-runs". */
  queue?: string;
  /** Path prefix for all routes (e.g. "/api"). Defaults to none. */
  pathPrefix?: string;
  /**
   * Auth resolver. Returns the authenticated userId, or null to reject (401).
   * Default: API-key bearer reads `Authorization: Bearer <key>`, validates
   * against `WEB_API_KEY` env var, and uses the literal string "api-key" as
   * the userId. Override for JWT, session cookies, or per-tenant keys.
   */
  auth?: (req: Request) => Promise<UserId | null>;
  /** Optional logger. */
  logger?: Logger;
  /** Skip migrations on boot. */
  skipMigrations?: boolean;
}

export interface WebHandle {
  server: ServerType;
  boss: PgBoss;
  pool: Pool;
  /** Stop accepting new requests, drain in-flight ones, close pools. */
  stop: () => Promise<void>;
}

const DEFAULT_QUEUE = "agent-runs";

export async function serveWeb(opts: ServeWebOpts): Promise<WebHandle> {
  const logger = opts.logger ?? buildLogger({ service: "web" });
  const queue = opts.queue ?? DEFAULT_QUEUE;
  const pathPrefix = opts.pathPrefix ?? "";

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("serveWeb: DATABASE_URL is required");

  const pool = getPool({ applicationName: "web" });
  if (!opts.skipMigrations) await applyMigrations(pool);

  const boss = new PgBoss(connectionString);
  boss.on("error", (err: Error) => logger.error({ err: err.message }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(queue);

  const auth = opts.auth ?? defaultApiKeyAuth();
  const agents = resolveAgents(opts);

  const app = new Hono();
  const r = (path: string) => `${pathPrefix}${path}`;

  app.get(r("/healthz"), (c) => c.json({ ok: true, queue, agents: Object.keys(agents) }));

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

  app.get(r("/runs/:id/stream"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const run = await loadRunForUser(pool, id, userId);
    if (!run) return c.json({ error: "not_found" }, 404);

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
            const messages = await listMessages(pool, id);
            const m = messages.find((x) => x.id === parsed.messageId);
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
    const kv = tryGetKv(logger);
    if (!kv) {
      return c.json({ error: "cancel_unavailable", message: "no KV configured" }, 503);
    }
    await requestCancel(kv, id, "web_request");
    logger.info({ runId: id, userId }, "cancel requested");
    return c.json({ runId: id, cancelRequested: true });
  });

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
    await appendMessage(pool, { runId: id, role: "user", content });
    await setRunStatus(pool, id, "pending");
    await boss.send(queue, {
      runId: id,
      agentName: run.agentName,
      ...(run.userId ? { userId: run.userId } : {}),
    });
    logger.info({ runId: id, userId }, "input injected; run re-enqueued");
    return c.json({ runId: id, status: "pending" });
  });

  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const hostname = opts.hostname ?? "0.0.0.0";
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    logger.info(
      { port: info.port, address: info.address, queue, prefix: pathPrefix || "(none)" },
      "web service listening",
    );
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))).catch(
      (err) => logger.error({ err: err.message }, "server.close errored"),
    );
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {});
    await closeSharedPool().catch(() => {});
  };
  installShutdownHandlers(stop, logger);

  return { server, boss, pool, stop };
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

interface RunCreateBody {
  input: string;
  agentName?: string;
  metadata?: Record<string, unknown>;
}

function resolveAgents(opts: ServeWebOpts): Record<string, AgentDefinition> {
  if (opts.agents && Object.keys(opts.agents).length > 0) return opts.agents;
  if (opts.agent) return { [opts.agent.name]: opts.agent };
  throw new Error("serveWeb: pass `agent` or `agents`");
}

function defaultApiKeyAuth(): (req: Request) => Promise<UserId | null> {
  const expected = process.env.WEB_API_KEY;
  if (!expected) {
    return async () => {
      // Fail closed: refuse all requests until WEB_API_KEY is set.
      return null;
    };
  }
  return async (req) => {
    const header = req.headers.get("authorization") ?? "";
    if (!header.toLowerCase().startsWith("bearer ")) return null;
    const presented = header.slice("bearer ".length).trim();
    return constantTimeEquals(presented, expected) ? "api-key" : null;
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function serializeMessage(m: {
  id: string;
  role: string;
  content: ContentBlock[];
  createdAt: Date;
  usage?: unknown;
}) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    ...(m.usage ? { usage: m.usage } : {}),
  };
}

function tryGetKv(logger: Logger): ReturnType<typeof getKv> | null {
  try {
    return getKv();
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, "no KV configured");
    return null;
  }
}

function installShutdownHandlers(stop: () => Promise<void>, logger: Logger): void {
  const handler = async (signal: NodeJS.Signals) => {
    logger.warn({ signal }, "shutting down web service");
    await stop();
    process.exit(0);
  };
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}

// Re-exports so consumers don't need to deep-import.
export type { Context };
