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
  /**
   * Override the TTL for the in-memory catalog cache (ms). Defaults to
   * 60s. Tests pass 0 to disable caching.
   */
  catalogCacheTtlMs?: number;
}

/**
 * Agent catalog + add routes on the deployed harness:
 *
 *   GET  /agents/catalog — proxy to the wizard's `/api/agents/catalog`.
 *                          The browser only ever talks same-origin,
 *                          which dodges the wizard's no-CORS posture.
 *                          Response is cached in-process for 60s (the
 *                          gallery only changes on a wizard redeploy)
 *                          to avoid hammering it on every modal open.
 *   POST /agents/add      — proxy to the wizard's `/api/agents/add`.
 *                          Requires `WIZARD_SHARED_SECRET` + a populated
 *                          `repoLocator` on `DeploymentInfo`; the
 *                          browser never carries either.
 *
 * Both routes require an authenticated operator session.
 */
export function registerAgentAddRoute(app: Hono, ctx: AgentAddRouteContext): void {
  const { auth, pathPrefix, deployment, wizardServiceUrl, wizardSharedSecret } = ctx;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const cacheTtlMs = ctx.catalogCacheTtlMs ?? 60_000;
  const r = (path: string) => `${pathPrefix}${path}`;

  // Module-local cache keyed by wizard URL. One ServeWeb instance hosts
  // one operator UI so the cardinality is 1 in practice — keying on the
  // URL just keeps the test harness happy when it varies the value.
  const catalogCache = new Map<string, { fetchedAt: number; body: string }>();

  app.get(r("/agents/catalog"), async (c) => {
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
      const res = await fetchImpl(`${trimTrailingSlash(wizardServiceUrl)}/api/agents/catalog`);
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
