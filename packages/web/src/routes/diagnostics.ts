import type { DeploymentInfo, DiagnosticCheck } from "@render-harness/contracts";
import type { AgentDefinition, Pool, UserId } from "@render-harness/core";
import type { Hono } from "hono";

export type { DiagnosticCheck };

export interface DiagnosticsRouteContext {
  pool: Pool;
  auth: (req: Request) => Promise<UserId | null>;
  agents: Record<string, AgentDefinition>;
  queue: string;
  pathPrefix: string;
  deployment?: DeploymentInfo;
}

export function registerDiagnosticsRoutes(app: Hono, ctx: DiagnosticsRouteContext): void {
  const { pool, auth, agents, queue, pathPrefix, deployment } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;

  app.get(r("/diagnostics"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const checks = await runDiagnostics({
      pool,
      agents,
      queue,
      ...(deployment ? { deployment } : {}),
    });
    return c.json({ checks });
  });
}

interface RunDiagnosticsArgs {
  pool: Pool;
  agents: Record<string, AgentDefinition>;
  queue: string;
  deployment?: DeploymentInfo;
}

/**
 * Run the full diagnostic suite and return the results. Cheap to call
 * (a couple of round-trips at most) — the SPA polls this on a 30s
 * interval.
 */
async function runDiagnostics(args: RunDiagnosticsArgs): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  if (args.deployment?.harness) {
    const harness = args.deployment.harness;
    const check: DiagnosticCheck = {
      id: "harness_version",
      level: harness.status === "ok" ? "ok" : harness.status === "incompatible" ? "error" : "warn",
      title:
        harness.status === "ok"
          ? "Harness version is coherent"
          : harness.status === "unknown"
            ? "Harness version is unknown"
            : "Harness version needs attention",
      message:
        harness.messages.length > 0
          ? harness.messages.join(" ")
          : `Running ${Object.values(harness.running)[0] ?? "unknown"} for declared range ${harness.declaredRange ?? "unknown"}.`,
    };
    if (harness.status !== "ok") {
      check.hint =
        "Check the Config tab's Harness Version panel and update first-party packages together.";
    }
    checks.push(check);
  }

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
      hint: "Set UI_COOKIE_SECRET to a stable 32-byte hex string. The Blueprint generates one with `generateValue: true`.",
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
