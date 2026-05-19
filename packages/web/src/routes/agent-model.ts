/**
 * `PATCH /agents/:slug/model` — operator UI's Edit-model flow.
 *
 * Same two commit paths as `capability-install.ts`:
 *   1. deploy_key — preferred; clones the managed repo via SSH and
 *      runs the YAML mutation locally.
 *   2. wizard_proxy — legacy V1 path; forwards to the wizard with
 *      `Bearer WIZARD_SHARED_SECRET`.
 *
 * Pure mutator (`mutateAgentModel`) lives in
 * @render-harness/registry/repo-mutations so both paths share one
 * implementation of the YAML rewrite.
 */

import type { DeploymentInfo } from "@render-harness/contracts";
import type { AgentDefinition, UserId } from "@render-harness/core";
import {
  AgentNotFoundError,
  InvalidManifestError,
  mutateAgentModel,
} from "@render-harness/registry/repo-mutations";
import type { ModelSpecInput } from "@render-harness/registry/schema";
import type { Context, Hono } from "hono";
import { pickCommitPath } from "../lib/commit-shim.js";
import { withRepoClone } from "../lib/git-commit.js";

export interface AgentModelRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  agents: Record<string, AgentDefinition>;
  pathPrefix: string;
  deployment?: DeploymentInfo;
  wizardServiceUrl: string | null;
  wizardSharedSecret: string | null;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

interface PatchBody {
  spec: unknown;
  branch?: string;
}

const MANIFEST_PATH = "render-harness.yaml";

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

    let body: PatchBody;
    try {
      body = (await c.req.json()) as PatchBody;
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }

    const path = pickCommitPath({
      deployment,
      wizardSharedSecret,
      ...(ctx.env ? { env: ctx.env } : {}),
    });

    if (path.kind === "deploy_key") {
      return runDeployKeyEditModel({
        c,
        slug,
        spec: body.spec as ModelSpecInput,
        branch: body.branch ?? "main",
        repoSshUrl: path.repoSshUrl,
        deployKeyPem: path.deployKeyPem,
      });
    }

    if (path.kind === "wizard_proxy") {
      return runWizardProxyEditModel({
        c,
        slug,
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

async function runDeployKeyEditModel(args: {
  c: Context;
  slug: string;
  spec: ModelSpecInput;
  branch: string;
  repoSshUrl: string;
  deployKeyPem: string;
}): Promise<Response> {
  const { c, slug, spec, branch, repoSshUrl, deployKeyPem } = args;
  try {
    const { commit } = await withRepoClone({ repoSshUrl, deployKeyPem, branch }, async (ctx) => {
      const manifestText = await ctx.readFile(MANIFEST_PATH);
      if (manifestText === null) {
        throw new InvalidManifestError(`${MANIFEST_PATH} not found in repo`);
      }
      const nextManifest = mutateAgentModel({
        yamlText: manifestText,
        agentId: slug,
        spec,
      });
      if (nextManifest === manifestText) return null;
      await ctx.writeFile(MANIFEST_PATH, nextManifest);
      return { message: `chore: update model for ${slug}` };
    });
    return c.json({
      ok: true,
      unchanged: commit.changedFiles.length === 0,
      commitSha: commit.commitSha,
      changedFiles: commit.changedFiles,
      via: "deploy_key",
    });
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      return c.json({ error: "agent_not_found_in_manifest", details: err.message }, 404);
    }
    if (err instanceof InvalidManifestError) {
      return c.json({ error: "invalid_manifest", details: err.message }, 400);
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

async function runWizardProxyEditModel(args: {
  c: Context;
  slug: string;
  body: PatchBody;
  locator: NonNullable<DeploymentInfo["repoLocator"]>;
  wizardServiceUrl: string | null;
  wizardSharedSecret: string | null;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  const { c, slug, body, locator, wizardServiceUrl, wizardSharedSecret, fetchImpl } = args;
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
        details: "set WIZARD_SHARED_SECRET or migrate to GITHUB_DEPLOY_KEY",
      },
      503,
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
