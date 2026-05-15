/**
 * `PATCH /agents/:slug/model` — proxy that lets the operator UI commit
 * a new `model:` block for an agent without holding GitHub credentials
 * here. We authenticate the caller against the worker's normal auth
 * resolver, look up the repo locator from the loaded {@link
 * DeploymentInfo}, then forward to the wizard service which holds the
 * GitHub App.
 *
 * The split exists so the per-agent worker stays credential-free —
 * many deployments share one wizard, but each worker has its own auth
 * surface. The shared `WIZARD_SHARED_SECRET` env var authenticates the
 * server-to-server hop.
 */

import type { DeploymentInfo } from "@render-harness/contracts";
import type { AgentDefinition, UserId } from "@render-harness/core";
import type { Hono } from "hono";

export interface AgentModelRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  agents: Record<string, AgentDefinition>;
  pathPrefix: string;
  deployment?: DeploymentInfo;
  /**
   * Origin of the wizard service. Required for the route to do
   * anything; when unset the endpoint returns 503.
   */
  wizardServiceUrl: string | null;
  /**
   * Shared secret used in `Authorization: Bearer …` when proxying.
   * Required.
   */
  wizardSharedSecret: string | null;
  /**
   * Override the fetch used to call the wizard. Tests pass a stub.
   */
  fetchImpl?: typeof fetch;
}

interface PatchBody {
  spec: unknown;
}

export function registerAgentModelRoute(app: Hono, ctx: AgentModelRouteContext): void {
  const { auth, agents, pathPrefix, deployment, wizardServiceUrl, wizardSharedSecret } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;
  const fetchImpl = ctx.fetchImpl ?? fetch;

  app.patch(r("/agents/:slug/model"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    const slug = c.req.param("slug");
    if (!slug || !agents[slug]) {
      return c.json({ error: "agent_not_found", agent: slug ?? null }, 404);
    }

    if (!wizardServiceUrl) {
      return c.json(
        {
          error: "wizard_service_not_configured",
          details: "set RENDER_HARNESS_WIZARD_URL to enable in-UI model edits",
        },
        503,
      );
    }
    if (!wizardSharedSecret) {
      return c.json(
        {
          error: "wizard_shared_secret_not_configured",
          details: "set WIZARD_SHARED_SECRET on both this service and the wizard",
        },
        503,
      );
    }

    const locator = deployment?.repoLocator;
    if (!locator?.org || !locator?.repo) {
      return c.json(
        {
          error: "repo_locator_missing",
          details: "`.render-harness/agent.json` is missing or has null org/repo",
        },
        409,
      );
    }
    if (!locator.installationId) {
      return c.json(
        {
          error: "needs_install",
          details: "the render-harness GitHub App is not installed on this repo",
          installUrl: `${trimTrailingSlash(wizardServiceUrl)}/api/installs/start?agentSlug=${encodeURIComponent(slug)}`,
        },
        409,
      );
    }

    let body: PatchBody;
    try {
      body = (await c.req.json()) as PatchBody;
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }

    const url = `${trimTrailingSlash(wizardServiceUrl)}/api/agents/${encodeURIComponent(slug)}/model`;
    const res = await fetchImpl(url, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${wizardSharedSecret}`,
      },
      body: JSON.stringify({
        agentId: slug,
        org: locator.org,
        repo: locator.repo,
        installationId: locator.installationId,
        spec: body.spec,
      }),
    });

    const text = await res.text();
    const json = safeParseJson(text);
    return c.json(json ?? { error: "wizard_response_not_json", body: text }, res.status as 200);
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
