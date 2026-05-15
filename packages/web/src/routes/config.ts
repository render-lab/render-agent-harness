/**
 * Config routes: surface the merged envSchema with set/unset status,
 * and let the operator mutate env-var values via the Render API.
 *
 *   GET   /config/env-vars
 *     Returns the deployment's envSchema (same data as
 *     `DeploymentInfo.envSchema`) with fresh `isSet` flags read from
 *     `process.env` at request time. Lets the UI re-render after a
 *     write without a full `/deployment` reload.
 *
 *   PUT   /config/env-vars/:name
 *     Writes a new value through the Render API. Render auto-deploys
 *     the service on env changes, so the response is 202 and the UI
 *     polls `GET /config/env-vars` until `isSet` flips.
 *
 * Auth: same operator-UI session resolver as the rest of `web`. Render
 * dashboard ACLs already gate who can deploy; this is an additional
 * application-level check.
 *
 * NOTE: writing an env var triggers a Render redeploy that kills this
 * process mid-flight. The UI handles a disconnect on save as
 * "probably succeeded" and re-polls. We make the Render API call
 * before responding (so the operator gets a clear success/failure)
 * but write-then-restart is best-effort.
 */

import type { DeploymentEnvVar, DeploymentInfo } from "@render-harness/contracts";
import type { UserId } from "@render-harness/core";
import type { Hono } from "hono";

export interface ConfigRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  deployment?: DeploymentInfo;
  pathPrefix: string;
  /** Override the Render API base URL. Tests pass a stub origin. */
  renderApiBase?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

interface PutBody {
  value: unknown;
}

const DEFAULT_RENDER_API_BASE = "https://api.render.com";

export function registerConfigRoutes(app: Hono, ctx: ConfigRouteContext): void {
  const { auth, deployment, pathPrefix } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const apiBase = ctx.renderApiBase ?? DEFAULT_RENDER_API_BASE;

  app.get(r("/config/env-vars"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    const base = deployment?.envSchema ?? [];
    // Re-read isSet at request time so the UI gets fresh truth after
    // a write, without restarting the process.
    const fresh = base.map((spec): DeploymentEnvVar => {
      const value = process.env[spec.name];
      return { ...spec, isSet: typeof value === "string" && value.length > 0 };
    });
    return c.json({ envVars: fresh });
  });

  app.put(r("/config/env-vars/:name"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    const name = c.req.param("name");
    if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
      return c.json(
        { error: "invalid_env_var_name", details: "names must match [A-Z][A-Z0-9_]*" },
        400,
      );
    }

    const spec = deployment?.envSchema?.find((e) => e.name === name);
    if (!spec) {
      return c.json(
        { error: "env_var_not_in_schema", details: `${name} is not declared in envSchema` },
        404,
      );
    }

    const serviceId = deployment?.renderService?.serviceId;
    const apiKey = process.env.RENDER_API_KEY;
    if (!serviceId) {
      return c.json(
        {
          error: "render_service_not_configured",
          details: "RENDER_SERVICE_ID is unset; in-UI env-var writes need a Render service id",
        },
        503,
      );
    }
    if (!apiKey) {
      return c.json(
        {
          error: "render_api_key_not_configured",
          details: "set RENDER_API_KEY on this service to enable env-var writes",
        },
        503,
      );
    }

    let body: PutBody;
    try {
      body = (await c.req.json()) as PutBody;
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }
    if (typeof body.value !== "string") {
      return c.json({ error: "invalid_body", details: "expected { value: string }" }, 400);
    }

    // Render API: PUT /v1/services/:serviceId/env-vars/:key with { value }.
    // Replacing an existing key or creating a new one are the same call.
    const url = `${trimTrailingSlash(apiBase)}/v1/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(name)}`;
    const res = await fetchImpl(url, {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ value: body.value }),
    });

    const text = await res.text();
    if (!res.ok) {
      return c.json(
        {
          error: "render_api_error",
          status: res.status,
          details: text.slice(0, 1000),
        },
        res.status === 401 || res.status === 403 ? 502 : 502,
      );
    }
    // Render returns 200 with the updated env var. The service deploy
    // is triggered async; this process may be killed momentarily. The
    // UI handles a disconnect after a 200 here as "redeploy in
    // flight" and re-polls /config/env-vars until isSet stabilises.
    return c.json({ ok: true, name, restart: "expected" }, 202);
  });
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
