/**
 * `PATCH /api/agents/:slug/model` — commits a new `model:` block for
 * the named agent back to its scaffolded repo. Render's auto-deploy
 * picks up the commit and restarts the worker with the new model.
 *
 * Auth is server-to-server: the operator UI's deployed worker proxies
 * the request and authenticates with `WIZARD_SHARED_SECRET`. We don't
 * try to read the operator's session cookie here — cookies are
 * single-origin and the worker and wizard are different services.
 *
 * The wizard owns the GitHub App credentials. The worker tells us
 * which `(org, repo, installationId)` triple to commit to. We mint a
 * fresh installation token, fetch the current `render-harness.yaml`,
 * apply {@link mutateAgentModel}, and push the result. The prior
 * `sha` from `getContent` is fed back into `createOrUpdateFileContents`
 * — GitHub rejects the write on a mismatch, which guards against
 * concurrent edits.
 */

import { ModelSpecSchema } from "@render-harness/registry/schema";
import type { Hono } from "hono";
import { createOctokit, type GithubAppCreds } from "../github-app.js";
import type { ErrorResponse } from "../types.js";
import { AgentNotFoundError, InvalidManifestError, mutateAgentModel } from "../yaml-edit.js";

export interface RegisterAgentModelRouteOpts {
  /** Shared secret the worker presents in `Authorization: Bearer …`. */
  sharedSecret: string | null;
  /** App-level credentials minus `installationId` — supplied per-request. */
  github: Omit<GithubAppCreds, "installationId"> | null;
  deps?: {
    createOctokit?: typeof createOctokit;
  };
}

export interface AgentModelPatchBody {
  agentId: string;
  org: string;
  repo: string;
  installationId: string;
  branch?: string;
  spec: unknown;
}

const MANIFEST_PATH = "render-harness.yaml";

export function registerAgentModelRoute(app: Hono, opts: RegisterAgentModelRouteOpts): void {
  const createOctokitFn = opts.deps?.createOctokit ?? createOctokit;

  app.patch("/api/agents/:slug/model", async (c) => {
    if (!opts.sharedSecret) {
      return c.json<ErrorResponse>({ error: "shared_secret_not_configured" }, 503);
    }
    if (!opts.github) {
      return c.json<ErrorResponse>({ error: "github_not_configured" }, 503);
    }

    const auth = c.req.header("authorization") ?? "";
    if (!constantTimeEqual(auth, `Bearer ${opts.sharedSecret}`)) {
      return c.json<ErrorResponse>({ error: "unauthorized" }, 401);
    }

    let body: AgentModelPatchBody;
    try {
      body = (await c.req.json()) as AgentModelPatchBody;
    } catch {
      return c.json<ErrorResponse>({ error: "bad_json" }, 400);
    }

    const slug = c.req.param("slug");
    if (typeof body.agentId !== "string" || body.agentId !== slug) {
      return c.json<ErrorResponse>(
        { error: "agent_id_mismatch", details: "body.agentId must match :slug" },
        400,
      );
    }
    if (
      typeof body.org !== "string" ||
      typeof body.repo !== "string" ||
      typeof body.installationId !== "string"
    ) {
      return c.json<ErrorResponse>(
        { error: "missing_repo_locator", details: "org, repo, installationId are required" },
        400,
      );
    }

    const parsedSpec = ModelSpecSchema.safeParse(body.spec);
    if (!parsedSpec.success) {
      return c.json<ErrorResponse>(
        { error: "invalid_model_spec", details: parsedSpec.error.message },
        400,
      );
    }
    const spec = parsedSpec.data;
    const branch = body.branch ?? "main";

    let octokit: Awaited<ReturnType<typeof createOctokit>>;
    try {
      octokit = await createOctokitFn({
        creds: { ...opts.github, installationId: body.installationId },
      });
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "github_auth_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    // Fetch the current manifest. Token-scoped to this installation:
    // if the user revoked access or installation doesn't cover the
    // repo, GitHub returns 404.
    let currentText: string;
    let currentSha: string;
    try {
      const res = await octokit.repos.getContent({
        owner: body.org,
        repo: body.repo,
        path: MANIFEST_PATH,
        ref: branch,
      });
      const data = res.data;
      if (Array.isArray(data) || data.type !== "file") {
        return c.json<ErrorResponse>(
          { error: "manifest_not_a_file", details: `${MANIFEST_PATH} is not a regular file` },
          400,
        );
      }
      currentSha = data.sha;
      currentText = Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8");
    } catch (err) {
      if (isOctokitError(err) && err.status === 404) {
        return c.json<ErrorResponse>(
          {
            error: "repo_or_installation_not_found",
            details: `${body.org}/${body.repo}@${branch}:${MANIFEST_PATH} not reachable for installation ${body.installationId}`,
          },
          409,
        );
      }
      return c.json<ErrorResponse>(
        {
          error: "github_read_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    let nextText: string;
    try {
      nextText = mutateAgentModel({ yamlText: currentText, agentId: body.agentId, spec });
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return c.json<ErrorResponse>({ error: "agent_not_found", details: err.message }, 404);
      }
      if (err instanceof InvalidManifestError) {
        return c.json<ErrorResponse>({ error: "invalid_manifest", details: err.message }, 400);
      }
      return c.json<ErrorResponse>(
        {
          error: "yaml_edit_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    if (nextText === currentText) {
      return c.json({ ok: true, unchanged: true });
    }

    try {
      const result = await octokit.repos.createOrUpdateFileContents({
        owner: body.org,
        repo: body.repo,
        path: MANIFEST_PATH,
        message: `chore(${body.agentId}): update model via operator UI`,
        content: Buffer.from(nextText, "utf8").toString("base64"),
        sha: currentSha,
        branch,
      });
      return c.json({
        ok: true,
        commitSha: result.data.commit.sha ?? null,
        contentSha: result.data.content?.sha ?? null,
      });
    } catch (err) {
      if (isOctokitError(err) && err.status === 409) {
        return c.json<ErrorResponse>(
          { error: "stale_sha", details: "manifest changed under us; retry" },
          409,
        );
      }
      return c.json<ErrorResponse>(
        {
          error: "github_write_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });
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
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
