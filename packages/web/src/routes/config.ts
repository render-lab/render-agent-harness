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
 *     Writes a new value through the Render API, then explicitly
 *     triggers a deploy so the running service picks up the new
 *     value. Returns 202 (queued). The UI polls
 *     `GET /config/env-vars` until `isSet` flips on the new
 *     instance.
 *
 * Why we trigger the deploy explicitly: Render's
 * `PUT /v1/services/:id/env-vars/:key` endpoint *saves* the variable
 * but does not roll the service. (The dashboard's "save and deploy"
 * is a UI convenience; the API has no equivalent flag.) Without an
 * explicit `POST /v1/services/:id/deploys` follow-up, the env-var
 * change is saved on Render's side but `process.env` on the running
 * container is unchanged until the next deploy fires for some other
 * reason — which is exactly the "save & restart did nothing"
 * symptom operators were hitting on the Vitals toggle and ad-hoc
 * env writes. We chase the PUT with a `deployMode: "deploy_only"`
 * POST (no rebuild) which is the cheapest way to recycle the
 * process with the new env in scope.
 *
 * Auth: same operator-UI session resolver as the rest of `web`. Render
 * dashboard ACLs already gate who can deploy; this is an additional
 * application-level check.
 *
 * NOTE: the deploy trigger fires-and-forgets. Render kills this
 * process mid-flight once the new deploy is live, so the response we
 * return is "queued, expect a restart shortly". The UI handles a
 * disconnect on save as "probably succeeded" and re-polls.
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
    const apiRoot = trimTrailingSlash(apiBase);
    const putUrl = `${apiRoot}/v1/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(name)}`;
    const putRes = await fetchImpl(putUrl, {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ value: body.value }),
    });

    const putText = await putRes.text();
    if (!putRes.ok) {
      return c.json(
        {
          error: "render_api_error",
          status: putRes.status,
          details: putText.slice(0, 1000),
        },
        502,
      );
    }

    // Render saved the value, but the env-var endpoint by itself does
    // NOT roll the service — operators hit "saved, nothing happens"
    // until the next manual deploy. Chase the write with an explicit
    // `deploy_only` deploy: skips the build, just rotates the
    // container so the new env-var lands in `process.env`.
    const deployUrl = `${apiRoot}/v1/services/${encodeURIComponent(serviceId)}/deploys`;
    let deployStatus: number | null = null;
    let deployBody: string | null = null;
    try {
      const deployRes = await fetchImpl(deployUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ deployMode: "deploy_only" }),
      });
      deployStatus = deployRes.status;
      if (!deployRes.ok) deployBody = (await deployRes.text()).slice(0, 1000);
    } catch (err) {
      // Render frequently kills this process mid-flight once the
      // deploy queues, so the POST may never get a response. Treat
      // any network error as "the kill landed first" — best-effort
      // success.
      deployBody = err instanceof Error ? err.message : String(err);
    }

    // 201/202 from Render's deploys endpoint both indicate the deploy
    // is queued. Anything else is reported back to the operator so
    // they know the value saved but the restart didn't fire — they
    // can hit "manual deploy" in the dashboard to finish the job.
    const deployQueued = deployStatus === 201 || deployStatus === 202;
    return c.json(
      {
        ok: true,
        name,
        restart: deployQueued ? "queued" : "save_only",
        ...(deployQueued
          ? {}
          : {
              deployError: {
                status: deployStatus,
                details: deployBody?.slice(0, 500) ?? null,
              },
            }),
      },
      202,
    );
  });
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
