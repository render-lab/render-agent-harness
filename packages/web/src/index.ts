import { type ServerType, serve } from "@hono/node-server";
import {
  type AgentDefinition,
  type AgentRun,
  aggregateUsage,
  appendMessage,
  applyMigrations,
  buildLogger,
  type BuiltinPreview,
  type ContentBlock,
  closeSharedKv,
  closeSharedPool,
  getKvSafe,
  getPool,
  type ListRunsFilter,
  type Logger,
  listMessages,
  listRuns,
  listToolCalls,
  loadMessage,
  loadRunForUser,
  type NotifyPayload,
  type Pool,
  previewBuiltins,
  type RunStatus,
  requestCancel,
  type SkippedBuiltin,
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
 * Optional operator UI mount. The shape mirrors `@render-harness/ui`'s
 * `MountUiOpts` minus the fields we already have here (`app`, `pool`,
 * `agents`, `auth`, `apiPrefix`). Kept as a structural type so this
 * package doesn't depend on `@render-harness/ui` — it's loaded
 * dynamically when `ui` is set.
 */
export interface UiMountConfig {
  /** Mount path. Defaults to "/ui". */
  path?: string;
  /** Cookie session secret. Falls back to UI_COOKIE_SECRET env. */
  cookieSecret?: string;
  cookieName?: string;
  cookieMaxAge?: number;
  cookieSecure?: boolean;
  /** Override the directory containing the SPA bundle. */
  staticDir?: string;
}

/**
 * Multi-tenant public HTTP service. Sits in front of `runtime-worker` and
 * is the canonical "Phase 3 production shape" web entrypoint.
 *
 * Endpoints (all under the optional path prefix):
 *
 *   POST /runs                   — enqueue a new run; returns runId immediately.
 *   GET  /runs                   — list runs with status/agent filters and
 *                                   keyset pagination.
 *   GET  /runs/:id               — fetch run row + full message history.
 *   GET  /runs/:id/tool-calls    — tool calls for a run, joined to results.
 *   GET  /runs/:id/stream        — Server-Sent Events stream of messages,
 *                                   tool calls, and tool results, fed by
 *                                   Postgres LISTEN/NOTIFY pointers.
 *   POST /runs/:id/cancel        — write KV cancel flag; the worker observes
 *                                   it between turns and tool calls and
 *                                   aborts cooperatively.
 *   POST /runs/:id/input         — inject a user message into a paused run
 *                                   and re-enqueue it. HITL endpoint.
 *   GET  /agents                 — summary of agents loaded into this service.
 *   GET  /usage                  — daily/per-agent rollups of runs, cost,
 *                                   and tokens.
 *   GET  /healthz                — liveness probe.
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
  /**
   * Mount the operator UI from `@render-harness/ui`. Pass `true` for
   * defaults (UI at `/ui`, cookie session backed by `UI_COOKIE_SECRET`)
   * or an object to override.
   *
   * The UI package is loaded dynamically so the dependency stays
   * optional — services that don't want it don't pay the bundle cost.
   */
  ui?: boolean | UiMountConfig;
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

  const upstreamAuth = opts.auth ?? defaultApiKeyAuth();
  const agents = resolveAgents(opts);

  // When the UI is enabled we wrap the upstream auth resolver so it also
  // accepts the signed session cookie set by `/ui/login`. Web doesn't know
  // how to read the cookie itself — that lives in @render-harness/ui.
  const auth = opts.ui
    ? await wrapWithUiSessionIfAvailable(upstreamAuth, opts.ui, logger)
    : upstreamAuth;

  const app = new Hono();
  const r = (path: string) => `${pathPrefix}${path}`;

  // `bootedAt` lets the operator UI's Guide compute "last reload" without a
  // separate endpoint — the value is captured once when the service starts
  // and stays the same for the lifetime of the process.
  const bootedAt = new Date().toISOString();

  app.get(r("/healthz"), (c) =>
    c.json({ ok: true, queue, agents: Object.keys(agents), bootedAt }),
  );

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

    // For runs sitting `paused` (chat-shape between turns, HITL waiting,
    // etc.) there's no worker process currently running to observe a KV
    // flag. Just flip the DB status directly. We *also* set the KV flag
    // for symmetry — a producer racing to re-enqueue it would still see
    // the cancel.
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

  app.get(r("/agents"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    return c.json({ agents: Object.values(agents).map(summariseAgent) });
  });

  app.get(r("/usage"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const url = new URL(c.req.url);
    const allUsers = url.searchParams.get("allUsers") === "1";
    const from = parseDate(url.searchParams.get("from"));
    const to = parseDate(url.searchParams.get("to"));
    const rollups = await aggregateUsage(pool, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(allUsers ? {} : { userId }),
    });
    return c.json({ rollups });
  });

  app.get(r("/diagnostics"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const checks = await runDiagnostics({ pool, agents, queue });
    return c.json({ checks });
  });

  app.get(r("/blueprint"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const yaml = renderBlueprint({ agents, queue });
    return c.body(yaml, 200, { "content-type": "text/yaml; charset=utf-8" });
  });

  if (opts.ui) {
    const uiCfg: UiMountConfig = typeof opts.ui === "object" ? opts.ui : {};
    await mountUiIfAvailable(app, {
      auth,
      logger,
      ...uiCfg,
    });
  }

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
    await closeSharedKv().catch(() => {});
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

function serializeRun(run: AgentRun) {
  return {
    id: run.id,
    agentName: run.agentName,
    agentVersion: run.agentVersion,
    status: run.status,
    userId: run.userId,
    cursor: run.cursor,
    totalCostUsd: run.totalCostUsd,
    metadata: run.metadata,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

const SYSTEM_PROMPT_PREVIEW_CHARS = 400;
const VALID_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

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

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface AgentSummary {
  name: string;
  version: string;
  model: { provider: string; model: string };
  systemPromptPreview: string;
  systemPromptLength: number;
  mcpServers: { name: string; transport: "stdio" | "http" }[];
  permissions: {
    allowedTools?: string[];
    deniedTools?: string[];
    requireApproval?: string[];
  };
  budget?: AgentDefinition["budget"];
  sampling?: AgentDefinition["sampling"];
  hasLocalTools: boolean;
  hasSkills: boolean;
  /**
   * Builtin tools registered for this agent given the current process env,
   * with the agent's own deniedTools / allowedTools applied. Names that
   * would otherwise register but are blocked by permissions appear under
   * `builtinsSkipped` with reason `"denied by agent permissions"`.
   */
  builtinsRegistered: string[];
  builtinsSkipped: SkippedBuiltin[];
  /**
   * Capability pack names declared on the agent (via `defineAgent`'s
   * `capabilityPacks` field). Pure metadata — the harness uses this only
   * to surface "this agent uses Pack X" in the operator UI.
   */
  capabilityPacks: string[];
}

/**
 * Outcome of a single diagnostic check. The operator UI groups by
 * `level`, surfaces "error" entries as a top banner, and renders the
 * full list in a Diagnostics panel.
 */
export interface DiagnosticCheck {
  id: string;
  level: "ok" | "warn" | "error";
  title: string;
  message: string;
  /** Optional one-line action a human can take to fix the issue. */
  hint?: string;
}

interface RunDiagnosticsArgs {
  pool: Pool;
  agents: Record<string, AgentDefinition>;
  queue: string;
}

/**
 * Run the full diagnostic suite and return the results. Cheap to call
 * (a couple of round-trips at most) — the SPA polls this on a 30s
 * interval.
 */
async function runDiagnostics(args: RunDiagnosticsArgs): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  // Auth: web's bearer auth fails closed without WEB_API_KEY.
  if (!process.env.WEB_API_KEY) {
    checks.push({
      id: "web_api_key",
      level: "error",
      title: "WEB_API_KEY is not set",
      message:
        "The web service refuses every request when WEB_API_KEY is unset. The UI works but no JSON endpoints will respond.",
      hint: "Set WEB_API_KEY in the service's environment, then redeploy.",
    });
  } else {
    checks.push({
      id: "web_api_key",
      level: "ok",
      title: "WEB_API_KEY is set",
      message: "Bearer auth is configured.",
    });
  }

  // Cookie session secret. Falls back to ephemeral, which works but means
  // operator browser sessions don't survive a restart.
  if (!process.env.UI_COOKIE_SECRET) {
    checks.push({
      id: "ui_cookie_secret",
      level: "warn",
      title: "UI_COOKIE_SECRET is not set",
      message:
        "The UI session cookie is signed with a per-process random secret. Operator logins won't survive a restart.",
      hint: 'Set UI_COOKIE_SECRET to a stable 32-byte hex string. The Blueprint generates one with `generateValue: true`.',
    });
  }

  // Per-agent provider keys. Looks at every loaded agent and verifies the
  // env var the model adapter will actually try to read.
  const seenKeys = new Set<string>();
  for (const agent of Object.values(args.agents)) {
    const envName = providerKeyEnvName(agent);
    if (!envName || seenKeys.has(envName)) continue;
    seenKeys.add(envName);
    if (!process.env[envName]) {
      checks.push({
        id: `provider_key_${envName}`,
        level: "error",
        title: `${envName} is not set`,
        message: `Agent "${agent.name}" uses ${agent.model.provider}/${agent.model.model}, which reads ${envName} from the environment. Runs will fail with a missing-key error.`,
        hint: `Set ${envName} in the service's environment, then redeploy.`,
      });
    } else {
      checks.push({
        id: `provider_key_${envName}`,
        level: "ok",
        title: `${envName} is set`,
        message: `Provider key for ${agent.model.provider}/${agent.model.model} is present.`,
      });
    }
  }

  // Database round-trip. We've been hitting the pool to get this far, but
  // an explicit "SELECT 1" surfaces the connection state in the panel.
  try {
    await args.pool.query("SELECT 1");
    checks.push({
      id: "database",
      level: "ok",
      title: "Postgres reachable",
      message: "DATABASE_URL is connected.",
    });
  } catch (err) {
    checks.push({
      id: "database",
      level: "error",
      title: "Postgres unreachable",
      message: err instanceof Error ? err.message : String(err),
      hint: "Check DATABASE_URL and that the database is running.",
    });
  }

  // Key Value (Valkey) — optional, but cancellation depends on it.
  if (!process.env.KV_URL) {
    checks.push({
      id: "kv",
      level: "warn",
      title: "KV_URL is not configured",
      message:
        "Cooperative cancellation needs a Key Value store. Cancel buttons will return 503 until KV_URL is set.",
    });
  } else {
    checks.push({
      id: "kv",
      level: "ok",
      title: "KV_URL is configured",
      message: "Cancellation flag store is wired up.",
    });
  }

  // Agents loaded.
  const agentNames = Object.keys(args.agents);
  if (agentNames.length === 0) {
    checks.push({
      id: "agents",
      level: "error",
      title: "No agents loaded",
      message: "serveWeb({ agent }) or serveWeb({ agents }) was not given any agent definitions.",
    });
  } else {
    checks.push({
      id: "agents",
      level: "ok",
      title: `${agentNames.length} agent${agentNames.length === 1 ? "" : "s"} loaded`,
      message: agentNames.join(", "),
    });
  }

  return checks;
}

function providerKeyEnvName(agent: AgentDefinition): string | null {
  if (agent.model.apiKeyEnv) return agent.model.apiKeyEnv;
  if (agent.model.provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (agent.model.provider === "openai-compat") return "OPENAI_API_KEY";
  return null;
}

/**
 * Emit a starter `render.yaml` Blueprint for the loaded agent. Mirrors
 * the structure of `blueprints/render.private.yaml` but parameterised
 * by the agent and queue this service is configured with so the user
 * gets a copy-pasteable starting point that matches their local stack.
 *
 * Deliberately conservative: the emitted yaml uses placeholders for
 * destination paths (rootDir, build/start commands) so the user can
 * adapt it to their repo layout. Required env vars are listed but
 * marked `sync: false` — the user fills them in via the Dashboard.
 */
function renderBlueprint(args: {
  agents: Record<string, AgentDefinition>;
  queue: string;
}): string {
  const agentList = Object.values(args.agents);
  const primary = agentList[0];
  const agentName = primary?.name ?? "operator-demo";
  const slug = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // Aggregate provider keys from every loaded agent so any model the
  // user might be using shows up in the env list.
  const providerKeys = new Set<string>();
  for (const a of agentList) {
    if (a.model.apiKeyEnv) providerKeys.add(a.model.apiKeyEnv);
    else if (a.model.provider === "anthropic") providerKeys.add("ANTHROPIC_API_KEY");
    else if (a.model.provider === "openai-compat") providerKeys.add("OPENAI_API_KEY");
  }

  const providerEnvLines = [...providerKeys]
    .map((name) => `      - key: ${name}\n        sync: false`)
    .join("\n");

  return `# yaml-language-server: $schema=https://render.com/schema/render.yaml.json
#
# Starter Blueprint generated by /blueprint for the "${agentName}" agent.
# Mirrors the operator-demo local stack: public web service + private
# worker pserv + Postgres + Key Value. Adjust rootDir / buildCommand /
# startCommand to match your repo layout, then deploy.

databases:
  - name: ${slug}-db
    plan: basic-256mb
    region: oregon
    postgresMajorVersion: "17"

services:
  - type: web
    name: ${slug}-web
    runtime: node
    region: oregon
    plan: starter
    rootDir: .
    buildCommand: corepack enable && pnpm install --frozen-lockfile && pnpm --filter @render-harness/example-${slug} build
    startCommand: node examples/${slug}/dist/web.js
    healthCheckPath: /healthz
    envVars:
      - key: NODE_ENV
        value: production
      - key: LOG_LEVEL
        value: info
      - key: WORKER_QUEUE
        value: ${args.queue}
      - key: DATABASE_URL
        fromDatabase:
          name: ${slug}-db
          property: connectionString
      - key: KV_URL
        fromService:
          name: ${slug}-kv
          type: keyvalue
          property: connectionString
      - key: WEB_API_KEY
        sync: false
      - key: UI_COOKIE_SECRET
        generateValue: true

  - type: pserv
    name: ${slug}-worker
    runtime: node
    region: oregon
    plan: starter
    rootDir: .
    buildCommand: corepack enable && pnpm install --frozen-lockfile && pnpm --filter @render-harness/example-${slug} build
    startCommand: node examples/${slug}/dist/worker.js
    envVars:
      - key: NODE_ENV
        value: production
      - key: LOG_LEVEL
        value: info
      - key: WORKER_QUEUE
        value: ${args.queue}
      - key: DATABASE_URL
        fromDatabase:
          name: ${slug}-db
          property: connectionString
      - key: KV_URL
        fromService:
          name: ${slug}-kv
          type: keyvalue
          property: connectionString
${providerEnvLines}

  - type: keyvalue
    name: ${slug}-kv
    plan: free
    region: oregon
    ipAllowList: []
`;
}

function summariseAgent(agent: AgentDefinition): AgentSummary {
  const fullPrompt = agent.systemPrompt ?? "";
  const preview =
    fullPrompt.length > SYSTEM_PROMPT_PREVIEW_CHARS
      ? `${fullPrompt.slice(0, SYSTEM_PROMPT_PREVIEW_CHARS)}…`
      : fullPrompt;

  const preview2 = previewBuiltins(process.env);
  const denied = new Set(agent.permissions?.deniedTools ?? []);
  const allowed = agent.permissions?.allowedTools;
  const builtinsRegistered: string[] = [];
  const builtinsSkipped: SkippedBuiltin[] = [...preview2.skipped];
  for (const name of preview2.registered) {
    if (denied.has(name)) {
      builtinsSkipped.push({ name, reason: "denied by agent permissions" });
      continue;
    }
    if (allowed && allowed.length > 0 && !allowed.includes(name)) {
      builtinsSkipped.push({ name, reason: "not in agent allowedTools" });
      continue;
    }
    builtinsRegistered.push(name);
  }

  const summary: AgentSummary = {
    name: agent.name,
    version: agent.version,
    model: { provider: agent.model.provider, model: agent.model.model },
    systemPromptPreview: preview,
    systemPromptLength: fullPrompt.length,
    mcpServers: (agent.mcpServers ?? []).map((s) => ({
      name: s.name,
      transport: s.transport,
    })),
    permissions: {
      ...(agent.permissions?.allowedTools ? { allowedTools: agent.permissions.allowedTools } : {}),
      ...(agent.permissions?.deniedTools ? { deniedTools: agent.permissions.deniedTools } : {}),
      ...(agent.permissions?.requireApproval
        ? { requireApproval: agent.permissions.requireApproval }
        : {}),
    },
    hasLocalTools: (agent.localTools ?? []).length > 0,
    hasSkills: agent.skills !== undefined,
    builtinsRegistered,
    builtinsSkipped,
    capabilityPacks: [...(agent.capabilityPacks ?? [])],
  };
  if (agent.budget) summary.budget = agent.budget;
  if (agent.sampling) summary.sampling = agent.sampling;
  return summary;
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

interface MountUiArgs {
  auth: (req: Request) => Promise<UserId | null>;
  logger: Logger;
  path?: string;
  cookieSecret?: string;
  cookieName?: string;
  cookieMaxAge?: number;
  cookieSecure?: boolean;
  staticDir?: string;
}

/**
 * Dynamic-import shape of `@render-harness/ui`. Kept as a structural type
 * here so this package doesn't take a hard dependency on the UI module —
 * services that don't enable the UI don't pay the install / bundle cost.
 */
interface UiModule {
  mountUi: (opts: {
    app: Hono;
    auth: (req: Request) => Promise<UserId | null>;
    path?: string;
    cookieSecret?: string;
    cookieName?: string;
    cookieMaxAge?: number;
    cookieSecure?: boolean;
    staticDir?: string;
  }) => void;
  wrapWithSession: (
    upstream: (req: Request) => Promise<UserId | null>,
    opts: {
      cookieSecret?: string;
      cookieName?: string;
      cookieMaxAge?: number;
      cookieSecure?: boolean;
    },
  ) => (req: Request) => Promise<UserId | null>;
}

async function loadUiModule(logger: Logger): Promise<UiModule | null> {
  try {
    const specifier = "@render-harness/ui";
    return (await import(/* @vite-ignore */ specifier)) as UiModule;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "ui: failed to load @render-harness/ui — install the package or set ui: false",
    );
    return null;
  }
}

async function wrapWithUiSessionIfAvailable(
  upstream: (req: Request) => Promise<UserId | null>,
  ui: boolean | UiMountConfig,
  logger: Logger,
): Promise<(req: Request) => Promise<UserId | null>> {
  const mod = await loadUiModule(logger);
  if (!mod) return upstream;
  const cfg = typeof ui === "object" ? ui : {};
  return mod.wrapWithSession(upstream, {
    ...(cfg.cookieSecret !== undefined ? { cookieSecret: cfg.cookieSecret } : {}),
    ...(cfg.cookieName !== undefined ? { cookieName: cfg.cookieName } : {}),
    ...(cfg.cookieMaxAge !== undefined ? { cookieMaxAge: cfg.cookieMaxAge } : {}),
    ...(cfg.cookieSecure !== undefined ? { cookieSecure: cfg.cookieSecure } : {}),
  });
}

async function mountUiIfAvailable(app: Hono, args: MountUiArgs): Promise<void> {
  const mod = await loadUiModule(args.logger);
  if (!mod) return;
  mod.mountUi({
    app,
    auth: args.auth,
    ...(args.path !== undefined ? { path: args.path } : {}),
    ...(args.cookieSecret !== undefined ? { cookieSecret: args.cookieSecret } : {}),
    ...(args.cookieName !== undefined ? { cookieName: args.cookieName } : {}),
    ...(args.cookieMaxAge !== undefined ? { cookieMaxAge: args.cookieMaxAge } : {}),
    ...(args.cookieSecure !== undefined ? { cookieSecure: args.cookieSecure } : {}),
    ...(args.staticDir !== undefined ? { staticDir: args.staticDir } : {}),
  });
  args.logger.info({ path: args.path ?? "/ui" }, "ui: operator UI mounted");
}

// Re-exports so consumers don't need to deep-import.
export type { Context };
