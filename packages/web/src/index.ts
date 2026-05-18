import { type ServerType, serve } from "@hono/node-server";
import type { DeploymentInfo } from "@render-harness/contracts";
import {
  type AgentDefinition,
  applyMigrations,
  buildLogger,
  closeSharedKv,
  closeSharedPool,
  getPool,
  installShutdownHandlers,
  type Logger,
  type Pool,
} from "@render-harness/core";
import { type Context, Hono } from "hono";
import { PgBoss } from "pg-boss";
import { defaultApiKeyAuth } from "./auth.js";
import { type ConnectorMountConfig, mountConnectorsIfAvailable } from "./connector-mount.js";
import { registerAgentAddRoute } from "./routes/agent-add.js";
import { registerAgentModelRoute } from "./routes/agent-model.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerBlueprintRoutes } from "./routes/blueprint.js";
import { registerCapabilityRoutes } from "./routes/capabilities.js";
import { registerCapabilityInstallRoute } from "./routes/capability-install.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerDeploymentRoutes } from "./routes/deployment.js";
import { registerDiagnosticsRoutes } from "./routes/diagnostics.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerVitalsRoutes } from "./routes/vitals.js";
import {
  mountUiIfAvailable,
  type UiMountConfig,
  wrapWithUiSessionIfAvailable,
} from "./ui-mount.js";

export type { ConnectorMountConfig } from "./connector-mount.js";
export type { DiagnosticCheck } from "./routes/diagnostics.js";
export type { UiMountConfig } from "./ui-mount.js";

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
 *                                   and re-enqueue it. HITL-only — `ask_user`
 *                                   / approval. Chat-turn-end is handled by
 *                                   the conversations API.
 *   POST /conversations          — create an ongoing thread the model loads
 *                                   history from across runs.
 *   GET  /conversations          — list conversations (keyset paginated).
 *   GET  /conversations/:id      — single conversation + full message stream.
 *   POST /conversations/:id/messages
 *                                 — append a user turn; enqueues a new run on
 *                                   this conversation. 409 if a prior turn is
 *                                   still in flight.
 *   GET  /conversations/:id/stream
 *                                 — SSE that fans in across every run in the
 *                                   conversation; stays open between turns.
 *   GET  /agents                 — summary of agents loaded into this service.
 *   GET  /usage                  — daily/per-agent rollups of runs, cost,
 *                                   and tokens.
 *   GET  /schedules              — list chat-created recurring runs.
 *   GET  /schedules/:id/runs     — history for one schedule.
 *   GET  /inbox                  — scheduled-run notification inbox.
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
  auth?: (req: Request) => Promise<import("@render-harness/core").UserId | null>;
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
  /**
   * Mount inbound connector webhooks at `/connectors/:key`. Pass explicit
   * capability refs, `"from-config"` to read `render-harness.yaml`, or an
   * object for custom entry root / env handling.
   */
  connectors?: ConnectorMountConfig;
  /**
   * Bundle metadata returned by `GET /deployment`. The operator UI uses
   * this to label the header and template the in-product Guide against
   * the actual running stack. If omitted, an `{ name: "agent" }` fallback
   * is synthesized from the loaded agents so the endpoint always
   * responds — but callers should pass this when they have richer info
   * (the scaffolded bundle entrypoints feed it from `config.name` etc.).
   */
  deployment?: DeploymentInfo;
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

  // `bootedAt` lets the operator UI's Guide compute "last reload" without a
  // separate endpoint — the value is captured once when the service starts
  // and stays the same for the lifetime of the process.
  const bootedAt = new Date().toISOString();

  app.get(`${pathPrefix}/healthz`, (c) =>
    c.json({ ok: true, queue, agents: Object.keys(agents), bootedAt }),
  );

  registerRunRoutes(app, {
    pool,
    boss,
    auth,
    logger,
    agents,
    queue,
    connectionString,
    pathPrefix,
  });
  registerConversationRoutes(app, {
    pool,
    boss,
    auth,
    logger,
    agents,
    queue,
    connectionString,
    pathPrefix,
  });
  registerAgentsRoutes(app, { auth, agents, pathPrefix });
  registerCapabilityRoutes(app, {
    auth,
    agents,
    pathPrefix,
    ...(opts.deployment ? { deployment: opts.deployment } : {}),
  });
  // Default the wizard URL server-side so the operator UI's add-agent /
  // install-capability / edit-model flows work without per-deployment
  // env-var configuration. `RENDER_HARNESS_WIZARD_URL` remains an
  // override for self-hosted wizards and local dev. See
  // `enrichDeploymentInfo` in @render-harness/registry for the matching
  // default on the `DeploymentInfo.wizardServiceUrl` field.
  const wizardServiceUrl =
    process.env.RENDER_HARNESS_WIZARD_URL ??
    opts.deployment?.wizardServiceUrl ??
    "https://render-agent-harness-wiz.onrender.com";
  const wizardSharedSecret = process.env.WIZARD_SHARED_SECRET ?? null;

  registerCapabilityInstallRoute(app, {
    auth,
    agents,
    pathPrefix,
    ...(opts.deployment ? { deployment: opts.deployment } : {}),
    wizardServiceUrl,
    wizardSharedSecret,
  });
  registerAgentAddRoute(app, {
    auth,
    agents,
    pathPrefix,
    ...(opts.deployment ? { deployment: opts.deployment } : {}),
    wizardServiceUrl,
    wizardSharedSecret,
  });
  registerDeploymentRoutes(app, {
    auth,
    agents,
    pathPrefix,
    ...(opts.deployment ? { deployment: opts.deployment } : {}),
  });
  registerAgentModelRoute(app, {
    auth,
    agents,
    pathPrefix,
    ...(opts.deployment ? { deployment: opts.deployment } : {}),
    wizardServiceUrl,
    wizardSharedSecret,
  });
  registerConfigRoutes(app, {
    auth,
    pathPrefix,
    ...(opts.deployment ? { deployment: opts.deployment } : {}),
  });
  registerVitalsRoutes(app, {
    auth,
    pathPrefix,
    ...(opts.deployment ? { deployment: opts.deployment } : {}),
  });
  registerUsageRoutes(app, { pool, auth, pathPrefix });
  registerScheduleRoutes(app, { pool, auth, pathPrefix });
  registerDiagnosticsRoutes(app, {
    pool,
    auth,
    agents,
    queue,
    pathPrefix,
    ...(opts.deployment ? { deployment: opts.deployment } : {}),
  });
  registerBlueprintRoutes(app, { auth, agents, queue, pathPrefix });

  if (opts.connectors) {
    await mountConnectorsIfAvailable({
      app,
      connectors: opts.connectors,
      auth,
      pool,
      boss,
      queue,
      logger,
      agents,
      pathPrefix,
    });
  }

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
  installShutdownHandlers(stop, logger, { service: "web" });

  return { server, boss, pool, stop };
}

function resolveAgents(opts: ServeWebOpts): Record<string, AgentDefinition> {
  if (opts.agents && Object.keys(opts.agents).length > 0) return opts.agents;
  if (opts.agent) return { [opts.agent.name]: opts.agent };
  throw new Error("serveWeb: pass `agent` or `agents`");
}

// Re-exports so consumers don't need to deep-import.
export type { Context };
