import { type ServerType, serve } from "@hono/node-server";
import {
  type AgentDefinition,
  appendMessage,
  applyMigrations,
  type Budget,
  buildLogger,
  type ContentBlock,
  createCancelSignal,
  createRun,
  DEFAULT_BUDGET,
  getKv,
  getPool,
  type Logger,
  type Message,
  runAgent,
  type ToolCall,
  type ToolResult,
} from "@render-harness/core";
import { Hono } from "hono";
import { stream } from "hono/streaming";

/**
 * Web runtime: runs the agent synchronously inside an HTTP request handler.
 *
 * One service, one process, one agent. For demo deployments, hackathons,
 * webhook receivers, and short synchronous agents (sub-30s expected). This is
 * NOT the production HTTP shell — for multi-tenant queue-driven runs use
 * `packages/web` (Phase 3) wrapping `runtime-worker`.
 *
 * Defaults are tuned for request-shaped runs:
 *   - `every-tool-call` checkpoint policy (we don't actually checkpoint here,
 *     but the policy keeps wall time tight if the agent stalls).
 *   - 5-minute wall budget (vs 11h in cron) — anything longer needs a queue.
 *   - 20-iteration cap.
 *   - SIGTERM aborts in-flight requests cleanly.
 *
 * Usage:
 *
 *   import { serveAgent } from "@render-harness/runtime-web";
 *   import { chatAgent } from "./agent.js";
 *
 *   await serveAgent({ agent: chatAgent });
 *
 * Endpoints (defaults):
 *   POST /runs         — synchronous; returns the final assistant message.
 *   POST /runs/stream  — Server-Sent Events stream of messages, tool calls,
 *                         and tool results as they happen.
 *   GET  /healthz      — liveness probe.
 */
export interface ServeAgentOpts {
  agent: AgentDefinition;
  /** TCP port to bind. Defaults to PORT env or 8080. */
  port?: number;
  /** Bind address. Defaults to 0.0.0.0 (Render requirement). */
  hostname?: string;
  /** Override route paths. */
  routes?: {
    create?: string;
    stream?: string;
    health?: string;
  };
  /**
   * Map an HTTP request body to the initial user message and run metadata.
   * Default: accepts `{ "input": "string" }` and converts to a single text
   * block. Return null to reject the request (the runtime returns 400).
   */
  buildInput?: (body: unknown) => InputResult | null | Promise<InputResult | null>;
  /**
   * Optional auth gate. Called for every /runs request. Return false (or
   * throw) to reject with 401. Default: no auth (suitable for demo only).
   */
  auth?: (req: Request) => boolean | Promise<boolean>;
  /** Override the per-run budget (capped by core's DEFAULT_BUDGET). */
  budget?: Partial<Budget>;
  /** Logger override; defaults to a pino instance. */
  logger?: Logger;
  /** Skip migrations (already applied externally). */
  skipMigrations?: boolean;
}

export interface InputResult {
  /** Initial user message content blocks. */
  content: ContentBlock[];
  /** Optional metadata to persist on the run row. */
  metadata?: Record<string, unknown>;
  /** Optional userId to scope the run to a tenant. */
  userId?: string;
}

const DEFAULT_WEB_BUDGET: Partial<Budget> = {
  maxIterations: 20,
  maxWallSeconds: 5 * 60,
};

/**
 * Boot the agent's HTTP service. Returns the underlying server so callers can
 * close it (mostly useful in tests).
 */
export async function serveAgent(opts: ServeAgentOpts): Promise<ServerType> {
  const logger = opts.logger ?? buildLogger({ service: "runtime-web" });
  const pool = getPool({ applicationName: `web:${opts.agent.name}` });
  const kv = tryGetKv(logger);

  if (!opts.skipMigrations) {
    await applyMigrations(pool);
  }

  const budget: Budget = {
    ...DEFAULT_BUDGET,
    ...DEFAULT_WEB_BUDGET,
    ...(opts.agent.budget ?? {}),
    ...(opts.budget ?? {}),
  };
  const agentDef: AgentDefinition = { ...opts.agent, budget };

  const buildInput = opts.buildInput ?? defaultBuildInput;
  const routes = {
    create: opts.routes?.create ?? "/runs",
    stream: opts.routes?.stream ?? "/runs/stream",
    health: opts.routes?.health ?? "/healthz",
  };

  const app = new Hono();

  app.get(routes.health, (c) => c.json({ ok: true, agent: agentDef.name }));

  app.post(routes.create, async (c) => {
    if (opts.auth && !(await opts.auth(c.req.raw))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = await buildInput(body);
    if (!parsed) return c.json({ error: "invalid_input" }, 400);

    const runId = globalThis.crypto.randomUUID();
    const upstream = new AbortController();
    const onAbort = () => upstream.abort();
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });

    let cancel: ReturnType<typeof createCancelSignal> | null = null;
    try {
      await createRun(pool, {
        id: runId,
        agentName: agentDef.name,
        agentVersion: agentDef.version,
        ...(parsed.userId !== undefined ? { userId: parsed.userId } : {}),
        metadata: { runtime: "web", route: routes.create, ...(parsed.metadata ?? {}) },
      });
      await appendMessage(pool, { runId, role: "user", content: parsed.content });

      let signal = upstream.signal;
      if (kv) {
        cancel = createCancelSignal({ runId, upstream: upstream.signal, kv });
        signal = cancel.signal;
      }

      const result = await runAgent(
        { runId, agentDef, signal, checkpoint: { kind: "run-to-completion" } },
        { pool, logger },
      );
      return c.json({ runId, ...result });
    } finally {
      cancel?.dispose();
      c.req.raw.signal.removeEventListener("abort", onAbort);
    }
  });

  app.post(routes.stream, async (c) => {
    if (opts.auth && !(await opts.auth(c.req.raw))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = await buildInput(body);
    if (!parsed) return c.json({ error: "invalid_input" }, 400);

    const runId = globalThis.crypto.randomUUID();

    return stream(c, async (s) => {
      const upstream = new AbortController();
      const onAbort = () => upstream.abort();
      c.req.raw.signal.addEventListener("abort", onAbort, { once: true });

      let cancel: ReturnType<typeof createCancelSignal> | null = null;
      const writeEvent = async (event: string, data: unknown) => {
        await s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        await createRun(pool, {
          id: runId,
          agentName: agentDef.name,
          agentVersion: agentDef.version,
          ...(parsed.userId !== undefined ? { userId: parsed.userId } : {}),
          metadata: {
            runtime: "web",
            route: routes.stream,
            stream: true,
            ...(parsed.metadata ?? {}),
          },
        });
        await appendMessage(pool, { runId, role: "user", content: parsed.content });
        await writeEvent("run_started", { runId });

        let signal = upstream.signal;
        if (kv) {
          cancel = createCancelSignal({ runId, upstream: upstream.signal, kv });
          signal = cancel.signal;
        }

        const result = await runAgent(
          {
            runId,
            agentDef,
            signal,
            checkpoint: { kind: "run-to-completion" },
            hooks: {
              onMessage: (m: Message) => writeEvent("message", serializeMessage(m)),
              onToolCall: (t: ToolCall) => writeEvent("tool_call", serializeToolCall(t)),
              onToolResult: (r: ToolResult) => writeEvent("tool_result", serializeToolResult(r)),
            },
          },
          { pool, logger },
        );
        await writeEvent("done", { runId, ...result });
      } catch (err) {
        await writeEvent("error", {
          runId,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        cancel?.dispose();
        c.req.raw.signal.removeEventListener("abort", onAbort);
      }
    });
  });

  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const hostname = opts.hostname ?? "0.0.0.0";
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    logger.info(
      { port: info.port, address: info.address, agent: agentDef.name },
      "runtime-web listening",
    );
  });

  installShutdownHandlers(server, logger);
  return server;
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function defaultBuildInput(body: unknown): InputResult | null {
  if (!body || typeof body !== "object") return null;
  const { input, metadata, userId } = body as {
    input?: unknown;
    metadata?: Record<string, unknown>;
    userId?: string;
  };
  if (typeof input !== "string" || input.trim() === "") return null;
  return {
    content: [{ type: "text", text: input }],
    ...(metadata ? { metadata } : {}),
    ...(userId ? { userId } : {}),
  };
}

function serializeMessage(m: Message): Record<string, unknown> {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    ...(m.usage ? { usage: m.usage } : {}),
  };
}

function serializeToolCall(t: ToolCall): Record<string, unknown> {
  return { id: t.id, name: t.name, input: t.input, createdAt: t.createdAt.toISOString() };
}

function serializeToolResult(r: ToolResult): Record<string, unknown> {
  return {
    toolCallId: r.toolCallId,
    isError: r.isError,
    durationMs: r.durationMs,
    truncatedContent: r.truncatedContent,
  };
}

function tryGetKv(logger: Logger): ReturnType<typeof getKv> | null {
  try {
    return getKv();
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "no KV configured; web runtime will not poll cancel flags",
    );
    return null;
  }
}

function installShutdownHandlers(server: ServerType, logger: Logger): void {
  const shutdown = (signal: NodeJS.Signals) => {
    logger.warn({ signal }, "shutting down runtime-web");
    server.close((err) => {
      if (err) {
        logger.error({ err: err.message }, "server.close errored");
        process.exit(1);
      }
      process.exit(0);
    });
    // Hard cap so a stuck request can't hold us past Render's grace period.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
