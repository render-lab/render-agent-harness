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
  /** TTL for the in-memory catalog cache (ms). Defaults to 60s; tests pass 0. */
  catalogCacheTtlMs?: number;
}

export function registerCapabilityInstallRoute(
  app: Hono,
  ctx: CapabilityInstallRouteContext,
): void {
  const { auth, agents, pathPrefix, deployment, wizardServiceUrl, wizardSharedSecret } = ctx;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const cacheTtlMs = ctx.catalogCacheTtlMs ?? 60_000;
  const r = (path: string) => `${pathPrefix}${path}`;

  // Module-local cache, keyed by wizard URL — same shape as the
  // agents-catalog proxy. The map of installable capabilities only
  // changes when the wizard service redeploys, so a 60s cache is fine.
  const catalogCache = new Map<string, { fetchedAt: number; body: string }>();

  // GET /capabilities/catalog — same-origin proxy to the wizard's
  // /api/capabilities/catalog. The browser never crosses origins (the
  // wizard ships no CORS headers); the operator UI's Install
  // capability modal calls this to enumerate every installable pack.
  app.get(r("/capabilities/catalog"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    if (!wizardServiceUrl) return c.json({ error: "wizard_service_not_configured" }, 503);

    const cacheKey = wizardServiceUrl;
    const now = Date.now();
    const cached = catalogCache.get(cacheKey);
    if (cached && cacheTtlMs > 0 && now - cached.fetchedAt < cacheTtlMs) {
      return new Response(cached.body, {
        status: 200,
        headers: { "content-type": "application/json", "x-cache": "HIT" },
      });
    }

    try {
      const res = await fetchImpl(
        `${trimTrailingSlash(wizardServiceUrl)}/api/capabilities/catalog`,
      );
      const text = await res.text();
      if (!res.ok) {
        return c.json({ error: "wizard_catalog_failed", status: res.status, details: text }, 502);
      }
      if (cacheTtlMs > 0) catalogCache.set(cacheKey, { fetchedAt: now, body: text });
      return new Response(text, {
        status: 200,
        headers: { "content-type": "application/json", "x-cache": "MISS" },
      });
    } catch (err) {
      return c.json(
        {
          error: "wizard_catalog_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

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
