import type { DeploymentInfo } from "@render-harness/contracts";
import type { AgentDefinition, UserId } from "@render-harness/core";
import type { Hono } from "hono";

export interface CapabilityInstallRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  agents: Record<string, AgentDefinition>;
  pathPrefix: string;
  deployment?: DeploymentInfo;
  wizardServiceUrl: string | null;
  wizardSharedSecret: string | null;
  fetchImpl?: typeof fetch;
}

export function registerCapabilityInstallRoute(
  app: Hono,
  ctx: CapabilityInstallRouteContext,
): void {
  const { auth, agents, pathPrefix, deployment, wizardServiceUrl, wizardSharedSecret } = ctx;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const r = (path: string) => `${pathPrefix}${path}`;

  app.post(r("/capabilities/install"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    if (!wizardServiceUrl) return c.json({ error: "wizard_service_not_configured" }, 503);
    if (!wizardSharedSecret) return c.json({ error: "wizard_shared_secret_not_configured" }, 503);
    const locator = deployment?.repoLocator;
    if (!locator?.org || !locator?.repo) return c.json({ error: "repo_locator_missing" }, 409);
    if (!locator.installationId) {
      return c.json(
        {
          error: "needs_install",
          installUrl: `${trimTrailingSlash(wizardServiceUrl)}/api/installs/start?agentSlug=capability-install`,
        },
        409,
      );
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "bad_json" }, 400);
    const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
    if (!agentId || !agents[agentId]) return c.json({ error: "agent_not_found" }, 404);
    const res = await fetchImpl(`${trimTrailingSlash(wizardServiceUrl)}/api/capabilities/install`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${wizardSharedSecret}`,
      },
      body: JSON.stringify({
        ...body,
        org: locator.org,
        repo: locator.repo,
        installationId: locator.installationId,
      }),
    });
    const text = await res.text();
    return c.json(
      safeParseJson(text) ?? { error: "wizard_response_not_json", body: text },
      res.status as 200,
    );
  });
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
