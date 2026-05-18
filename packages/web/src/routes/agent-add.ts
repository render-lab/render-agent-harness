import type { DeploymentInfo } from "@render-harness/contracts";
import type { AgentDefinition, UserId } from "@render-harness/core";
import type { Hono } from "hono";

export interface AgentAddRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  agents: Record<string, AgentDefinition>;
  pathPrefix: string;
  deployment?: DeploymentInfo;
  wizardServiceUrl: string | null;
  wizardSharedSecret: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * `POST /agents/add` — proxy from the deployed harness's web service
 * to the wizard's `POST /api/agents/add`. Mirrors the
 * capability-install proxy.
 *
 * Browser auth via cookie; wizard auth via WIZARD_SHARED_SECRET. The
 * `repoLocator` (org/repo/installationId) is attached server-side
 * from `DeploymentInfo` so the browser never carries it.
 */
export function registerAgentAddRoute(app: Hono, ctx: AgentAddRouteContext): void {
  const { auth, pathPrefix, deployment, wizardServiceUrl, wizardSharedSecret } = ctx;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const r = (path: string) => `${pathPrefix}${path}`;

  app.post(r("/agents/add"), async (c) => {
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
          installUrl: `${trimTrailingSlash(wizardServiceUrl)}/api/installs/start?agentSlug=agent-add`,
        },
        409,
      );
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "bad_json" }, 400);
    const bundleSlug = typeof body.bundleSlug === "string" ? body.bundleSlug : null;
    const agentId = typeof body.agentId === "string" ? body.agentId : null;
    if (!bundleSlug || !agentId) {
      return c.json({ error: "invalid_request", details: "bundleSlug + agentId required" }, 400);
    }

    const res = await fetchImpl(`${trimTrailingSlash(wizardServiceUrl)}/api/agents/add`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${wizardSharedSecret}`,
      },
      body: JSON.stringify({
        bundleSlug,
        agentId,
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
