/**
 * `POST /capabilities/install` — operator UI's Install-capability flow.
 *
 * Two commit paths, chosen at request time by `pickCommitPath`:
 *
 *   1. deploy_key — preferred, post-May-2026 default. The harness
 *      clones its own managed repo via the per-deployment SSH key in
 *      `GITHUB_DEPLOY_KEY`, runs the same pure planner/mutator the
 *      wizard does, and pushes the commit directly. No wizard
 *      involvement.
 *
 *   2. wizard_proxy — legacy V1 path. The harness POSTs to the wizard's
 *      `/api/capabilities/install` with `Bearer WIZARD_SHARED_SECRET`,
 *      and the wizard does the Octokit commit on the harness's behalf.
 *      Kept functional for harnesses that haven't rotated to the
 *      deploy-key flow yet; rotation is a Config-tab follow-up.
 *
 * `GET /capabilities/catalog` still always proxies the wizard, because
 * the catalog (`OFFICIAL_CAPABILITY_INSTALLS`) is part of the wizard's
 * deployable surface — making it work offline against a baked-in copy
 * is a separate follow-up.
 */

import type { DeploymentInfo } from "@render-harness/contracts";
import type { AgentDefinition, UserId } from "@render-harness/core";
import {
  type CapabilityAccessMode,
  CapabilityInstallError,
  mutateCapabilityInstallYaml,
  mutateEnvExample,
  mutatePackageJsonAddDependency,
  planCapabilityInstall,
} from "@render-harness/registry/repo-mutations";
import type { Context, Hono } from "hono";
import { pickCommitPath } from "../lib/commit-shim.js";
import { withRepoClone } from "../lib/git-commit.js";

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
  /**
   * Optional env source for the commit-path picker. Tests pass a fake;
   * production reads `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

interface CapabilityInstallBody {
  agentId: string;
  pack: string;
  accessMode: CapabilityAccessMode;
  config?: Record<string, unknown>;
  requireApproval?: boolean;
  branch?: string;
}

const MANIFEST_PATH = "render-harness.yaml";
const PACKAGE_PATH = "package.json";
const ENV_EXAMPLE_PATH = ".env.example";

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
    const locator = deployment?.repoLocator;
    if (!locator?.org || !locator?.repo) return c.json({ error: "repo_locator_missing" }, 409);

    const body = (await c.req.json().catch(() => null)) as CapabilityInstallBody | null;
    if (!body) return c.json({ error: "bad_json" }, 400);
    if (!body.agentId || !agents[body.agentId]) {
      return c.json({ error: "agent_not_found" }, 404);
    }
    if (typeof body.pack !== "string" || body.pack.length === 0) {
      return c.json({ error: "invalid_request", details: "pack required" }, 400);
    }
    if (body.accessMode !== "read" && body.accessMode !== "read_write") {
      return c.json({ error: "invalid_request", details: "accessMode required" }, 400);
    }

    const path = pickCommitPath({
      deployment,
      wizardSharedSecret,
      ...(ctx.env ? { env: ctx.env } : {}),
    });

    if (path.kind === "deploy_key") {
      return runDeployKeyInstall({
        c,
        body,
        repoSshUrl: path.repoSshUrl,
        deployKeyPem: path.deployKeyPem,
      });
    }

    if (path.kind === "wizard_proxy") {
      return runWizardProxyInstall({
        c,
        body,
        locator,
        wizardServiceUrl,
        wizardSharedSecret,
        fetchImpl,
      });
    }

    return c.json({ error: "edit_in_ui_not_configured", details: path.reason }, 503);
  });
}

async function runDeployKeyInstall(args: {
  c: Context;
  body: CapabilityInstallBody;
  repoSshUrl: string;
  deployKeyPem: string;
}): Promise<Response> {
  const { c, body, repoSshUrl, deployKeyPem } = args;
  const branch = body.branch ?? "main";

  try {
    const { commit, result } = await withRepoClone(
      { repoSshUrl, deployKeyPem, branch },
      async (ctx) => {
        const manifestText = await ctx.readFile(MANIFEST_PATH);
        const pkgText = await ctx.readFile(PACKAGE_PATH);
        if (manifestText === null || pkgText === null) {
          throw new CapabilityInstallError(
            "repo_layout_invalid",
            `${MANIFEST_PATH} or ${PACKAGE_PATH} missing in repo`,
          );
        }
        const envText = await ctx.readFile(ENV_EXAMPLE_PATH);

        const plan = planCapabilityInstall({
          yamlText: manifestText,
          install: {
            agentId: body.agentId,
            pack: body.pack,
            accessMode: body.accessMode,
            ...(body.config !== undefined ? { config: body.config } : {}),
            ...(body.requireApproval !== undefined
              ? { requireApproval: body.requireApproval }
              : {}),
          },
        });
        const nextManifest = mutateCapabilityInstallYaml({ yamlText: manifestText, plan });
        const nextPkg = mutatePackageJsonAddDependency({
          jsonText: pkgText,
          packageName: plan.spec.pack,
          versionRange: plan.spec.versionRange,
        });
        const nextEnv =
          envText !== null ? mutateEnvExample({ text: envText, envVars: plan.spec.envVars }) : null;

        if (nextManifest !== manifestText) await ctx.writeFile(MANIFEST_PATH, nextManifest);
        if (nextPkg !== pkgText) await ctx.writeFile(PACKAGE_PATH, nextPkg);
        if (nextEnv !== null && envText !== null && nextEnv !== envText) {
          await ctx.writeFile(ENV_EXAMPLE_PATH, nextEnv);
        }
        return {
          message: `chore: install ${plan.spec.pack}`,
          result: { warnings: plan.warnings, pack: plan.spec.pack },
        };
      },
    );

    return c.json({
      ok: true,
      unchanged: commit.changedFiles.length === 0,
      commitSha: commit.commitSha,
      changedFiles: commit.changedFiles,
      warnings: result?.warnings ?? [],
      via: "deploy_key",
    });
  } catch (err) {
    if (err instanceof CapabilityInstallError) {
      return c.json({ error: err.code, details: err.message }, 400);
    }
    return c.json(
      {
        error: "deploy_key_commit_failed",
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
}

async function runWizardProxyInstall(args: {
  c: Context;
  body: CapabilityInstallBody;
  locator: NonNullable<DeploymentInfo["repoLocator"]>;
  wizardServiceUrl: string | null;
  wizardSharedSecret: string | null;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  const { c, body, locator, wizardServiceUrl, wizardSharedSecret, fetchImpl } = args;
  if (!wizardServiceUrl) return c.json({ error: "wizard_service_not_configured" }, 503);
  if (!wizardSharedSecret) return c.json({ error: "wizard_shared_secret_not_configured" }, 503);
  if (!locator.installationId) {
    return c.json(
      {
        error: "needs_install",
        installUrl: `${trimTrailingSlash(wizardServiceUrl)}/api/installs/start?agentSlug=capability-install`,
      },
      409,
    );
  }
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
  const parsed = safeParseJson(text) as Record<string, unknown> | null;
  return c.json(
    parsed ? { ...parsed, via: "wizard_proxy" } : { error: "wizard_response_not_json", body: text },
    res.status as 200,
  );
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
