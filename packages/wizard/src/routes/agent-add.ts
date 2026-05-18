/**
 * `POST /api/agents/add` — appends an agent to an existing managed
 * harness's `render-harness.yaml`, writes its `src/<id>.ts`, dedupes
 * `capabilities[]` and `envSchema[]`, adds capability deps to
 * `package.json`, appends new env-var names to `.env.example`, and
 * re-emits `render.yaml` via `emitBlueprint` (only commits the
 * Blueprint when it actually changed).
 *
 * Auth: V1 ships with `Bearer WIZARD_SHARED_SECRET` only — the
 * deployed harness's `/ui` modal proxies through `packages/web`,
 * matching the capability-install flow. The session-cookie path used
 * by the wizard public site is wired in once the auth + ownership
 * layer lands.
 */

import type { Octokit } from "@octokit/rest";
import { emitBlueprint } from "@render-harness/registry/emitter";
import type { ResolvedGallery } from "@render-harness/registry/gallery";
import type { HarnessConfig } from "@render-harness/registry/schema";
import { parseHarnessConfigYaml } from "@render-harness/registry/schema";
import type { Context, Hono } from "hono";
import {
  AgentAddError,
  mutateEnvExampleForAgent,
  mutateManifestForAgentAdd,
  mutatePackageJsonAddDeps,
  planAgentAdd,
} from "../agent-add.js";
import { readSessionCookie } from "../auth.js";
import { createOctokit, type GithubAppCreds } from "../github-app.js";
import type { WizardStore } from "../store.js";
import type { ErrorResponse } from "../types.js";

export interface RegisterAgentAddRouteOpts {
  /** Bearer-secret used by the deployed /ui proxy. Unset = secret path disabled. */
  sharedSecret: string | null;
  github: Omit<GithubAppCreds, "installationId"> | null;
  gallery: ResolvedGallery;
  /** Optional ownership store + session secret for the session-cookie auth path. */
  store?: WizardStore;
  sessionSecret?: string | null;
  deps?: {
    createOctokit?: typeof createOctokit;
  };
}

interface AgentAddBody {
  /** Wire shape from the deployed /ui proxy: locator in body. */
  org?: string;
  repo?: string;
  installationId?: string;
  branch?: string;
  bundleSlug: string;
  agentId: string;
  /** Wire shape from the wizard SPA session-auth path: target by org/repo. */
  targetOrg?: string;
  targetRepo?: string;
}

interface ResolvedTarget {
  org: string;
  repo: string;
  installationId: string;
  branch: string;
}

const MANIFEST_PATH = "render-harness.yaml";
const PACKAGE_PATH = "package.json";
const ENV_EXAMPLE_PATH = ".env.example";
const RENDER_YAML_PATH = "render.yaml";

export function registerAgentAddRoute(app: Hono, opts: RegisterAgentAddRouteOpts): void {
  const createOctokitFn = opts.deps?.createOctokit ?? createOctokit;

  app.post("/api/agents/add", async (c) => {
    if (!opts.github) return c.json<ErrorResponse>({ error: "github_not_configured" }, 503);

    let body: AgentAddBody;
    try {
      body = (await c.req.json()) as AgentAddBody;
    } catch {
      return c.json<ErrorResponse>({ error: "bad_json" }, 400);
    }
    if (typeof body.bundleSlug !== "string" || typeof body.agentId !== "string") {
      return c.json<ErrorResponse>({ error: "invalid_agent_add" }, 400);
    }

    const target = await resolveTarget(c, body, opts);
    if ("error" in target) {
      return c.json<ErrorResponse>(
        { error: target.error, ...(target.details ? { details: target.details } : {}) },
        target.status as 401,
      );
    }

    let octokit: Octokit;
    try {
      octokit = await createOctokitFn({
        creds: { ...opts.github, installationId: target.installationId },
      });
    } catch (err) {
      return c.json<ErrorResponse>(
        { error: "github_auth_failed", details: err instanceof Error ? err.message : String(err) },
        502,
      );
    }

    const branch = target.branch;
    const locator = { org: target.org, repo: target.repo };
    try {
      const manifest = await readRepoFile(octokit, locator, MANIFEST_PATH, branch, true);
      const pkg = await readRepoFile(octokit, locator, PACKAGE_PATH, branch, true);
      if (!manifest || !pkg) {
        return c.json<ErrorResponse>({ error: "repo_or_installation_not_found" }, 409);
      }
      const env = await readRepoFile(octokit, locator, ENV_EXAMPLE_PATH, branch, false);
      const renderYaml = await readRepoFile(octokit, locator, RENDER_YAML_PATH, branch, false);

      // Source file path is plan-time; read existing content so we can
      // detect collisions without committing on conflict.
      const plan = planAgentAdd({
        gallery: opts.gallery,
        source: { bundleSlug: body.bundleSlug, agentId: body.agentId },
        manifestText: manifest.text,
        existingSourceFileText: null, // probe below
      });

      const existingSource = await readRepoFile(
        octokit,
        locator,
        plan.spec.sourceFilePath,
        branch,
        false,
      );
      // Re-plan with the discovered source file. If a collision exists
      // the planner throws AgentAddError("source_file_conflict").
      const finalPlan = planAgentAdd({
        gallery: opts.gallery,
        source: { bundleSlug: body.bundleSlug, agentId: body.agentId },
        manifestText: manifest.text,
        existingSourceFileText: existingSource?.text ?? null,
      });

      const nextManifest = mutateManifestForAgentAdd({
        yamlText: manifest.text,
        plan: finalPlan,
      });
      const nextPkg = mutatePackageJsonAddDeps({
        jsonText: pkg.text,
        capabilities: finalPlan.spec.capabilities,
      });
      const envVarNames = finalPlan.spec.envSchemaAdditions.map((e) => e.name);
      const nextEnv = env
        ? mutateEnvExampleForAgent({
            text: env.text,
            agentId: body.agentId,
            envVars: envVarNames,
          })
        : null;

      let nextRenderYaml: string | null = null;
      try {
        const cfg: HarnessConfig = parseHarnessConfigYaml(nextManifest);
        const emitted = await emitBlueprint({
          config: cfg,
          packageName: cfg.name,
          entrypointStyle: "repo",
        });
        nextRenderYaml = emitted.yaml;
      } catch (err) {
        // Manifest may be valid per yaml-edit but reject pack-level
        // validation. Surface clearly rather than committing a broken
        // manifest.
        return c.json<ErrorResponse>(
          {
            error: "blueprint_emit_failed",
            details: err instanceof Error ? err.message : String(err),
          },
          400,
        );
      }

      type Write = { text: string; sha: string | null };
      const writes = new Map<string, Write>();
      writes.set(MANIFEST_PATH, { text: nextManifest, sha: manifest.sha });
      writes.set(PACKAGE_PATH, { text: nextPkg, sha: pkg.sha });
      if (nextEnv && env) writes.set(ENV_EXAMPLE_PATH, { text: nextEnv, sha: env.sha });
      // Always write the source file if its contents differ (planner
      // already rejected hard conflicts).
      const existingSourceText = existingSource?.text ?? null;
      if (existingSourceText !== finalPlan.spec.sourceFileContent) {
        writes.set(finalPlan.spec.sourceFilePath, {
          text: finalPlan.spec.sourceFileContent,
          sha: existingSource?.sha ?? null,
        });
      }
      if (nextRenderYaml && nextRenderYaml !== renderYaml?.text) {
        writes.set(RENDER_YAML_PATH, {
          text: nextRenderYaml,
          sha: renderYaml?.sha ?? null,
        });
      }

      const changedFiles: string[] = [];
      let commitSha: string | null = null;
      for (const [path, next] of writes) {
        const current = currentText(path, manifest, pkg, env, existingSource, renderYaml);
        if (next.text === current) continue;
        const result = await octokit.repos.createOrUpdateFileContents({
          owner: locator.org,
          repo: locator.repo,
          path,
          branch,
          message: `chore: add agent ${body.agentId} from ${body.bundleSlug}`,
          content: Buffer.from(next.text, "utf8").toString("base64"),
          ...(next.sha ? { sha: next.sha } : {}),
        });
        changedFiles.push(path);
        commitSha = result.data.commit.sha ?? commitSha;
      }

      return c.json({
        ok: true,
        unchanged: changedFiles.length === 0,
        commitSha,
        changedFiles,
        warnings: finalPlan.warnings,
      });
    } catch (err) {
      if (err instanceof AgentAddError) {
        const status =
          err.code === "agent_id_exists" ||
          err.code === "source_file_conflict" ||
          err.code === "not_a_bundle"
            ? 409
            : err.code === "bundle_not_found" || err.code === "agent_not_found_in_bundle"
              ? 404
              : 400;
        return c.json<ErrorResponse>({ error: err.code, details: err.message }, status);
      }
      if (isOctokitError(err) && err.status === 404) {
        return c.json<ErrorResponse>(
          {
            error: "repo_or_installation_not_found",
            details: `${locator.org}/${locator.repo}@${branch} not reachable`,
          },
          409,
        );
      }
      if (isOctokitError(err) && err.status === 409) {
        return c.json<ErrorResponse>(
          { error: "stale_sha", details: "repo changed under us; retry" },
          409,
        );
      }
      return c.json<ErrorResponse>(
        { error: "github_write_failed", details: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });
}

function currentText(
  path: string,
  manifest: { text: string },
  pkg: { text: string },
  env: { text: string } | null,
  source: { text: string } | null,
  renderYaml: { text: string } | null,
): string | null {
  if (path === MANIFEST_PATH) return manifest.text;
  if (path === PACKAGE_PATH) return pkg.text;
  if (path === ENV_EXAMPLE_PATH) return env?.text ?? null;
  if (path === RENDER_YAML_PATH) return renderYaml?.text ?? null;
  // Source file path — match by suffix since the path is computed.
  return source?.text ?? null;
}

async function readRepoFile(
  octokit: Octokit,
  locator: { org: string; repo: string },
  path: string,
  branch: string,
  required: boolean,
): Promise<{ text: string; sha: string } | null> {
  try {
    const res = await octokit.repos.getContent({
      owner: locator.org,
      repo: locator.repo,
      path,
      ref: branch,
    });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file") {
      throw new AgentAddError("invalid_repo", `${path} is not a regular file`);
    }
    return {
      text: Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8"),
      sha: data.sha,
    };
  } catch (err) {
    if (!required && isOctokitError(err) && err.status === 404) return null;
    throw err;
  }
}

interface AuthFailure {
  error: string;
  details?: string;
  status: number;
}

/**
 * Resolve the request to a concrete target locator. Two paths:
 *
 *   1. Bearer WIZARD_SHARED_SECRET — locator must be in the body
 *      (`org` + `repo` + `installationId`). Used by the deployed /ui
 *      proxy.
 *   2. Session cookie — `targetOrg` + `targetRepo` in the body; the
 *      `installationId` is looked up from `wizard_user_repos`, scoped
 *      to the authenticated user. Used by the wizard SPA.
 */
async function resolveTarget(
  c: Context,
  body: AgentAddBody,
  opts: RegisterAgentAddRouteOpts,
): Promise<ResolvedTarget | AuthFailure> {
  const branch = body.branch ?? "main";
  const auth = c.req.header("authorization") ?? "";
  const hasBearer = auth.startsWith("Bearer ");
  if (hasBearer && opts.sharedSecret && constantTimeEqual(auth, `Bearer ${opts.sharedSecret}`)) {
    if (
      typeof body.org !== "string" ||
      typeof body.repo !== "string" ||
      typeof body.installationId !== "string"
    ) {
      return {
        error: "invalid_agent_add",
        details: "shared-secret path requires org + repo + installationId in body",
        status: 400,
      };
    }
    return { org: body.org, repo: body.repo, installationId: body.installationId, branch };
  }

  if (opts.store && opts.sessionSecret) {
    const session = readSessionCookie(c, opts.sessionSecret);
    if (session) {
      const targetOrg = typeof body.targetOrg === "string" ? body.targetOrg : null;
      const targetRepo = typeof body.targetRepo === "string" ? body.targetRepo : null;
      if (!targetOrg || !targetRepo) {
        return {
          error: "invalid_agent_add",
          details: "session-auth path requires targetOrg + targetRepo in body",
          status: 400,
        };
      }
      const row = await opts.store.getUserRepo({
        githubUserId: session.githubUserId,
        org: targetOrg,
        repo: targetRepo,
      });
      if (!row) {
        return {
          error: "not_owner",
          details: `${targetOrg}/${targetRepo} is not linked to your account`,
          status: 403,
        };
      }
      return { org: row.org, repo: row.repo, installationId: row.installationId, branch };
    }
  }

  return { error: "unauthorized", status: 401 };
}

function isOctokitError(err: unknown): err is { status: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
