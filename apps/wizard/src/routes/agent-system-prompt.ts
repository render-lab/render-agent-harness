/**
 * `PATCH /api/agents/:slug/system-prompt` — commits a new
 * `agent.systemPrompt` for the named agent back to its scaffolded repo.
 * Render's auto-deploy picks up the commit and restarts the worker with
 * the new prompt.
 *
 * Auth + GitHub-app flow mirror `agent-model.ts` exactly — only the YAML
 * mutation differs. See that file's header for the multi-tenant rationale.
 *
 * Only builtin (`kind: chat`) agents are editable through this path; the
 * mutator throws {@link AgentNotEditableError} for `kind: custom` agents,
 * which the route translates into a 409. Custom agents store their
 * prompt in TS source and the operator UI shows a read-only preview
 * with a pointer to the file.
 */

import type { Hono } from "hono";
import { createOctokit, type GithubAppCreds } from "../github-app.js";
import type { ErrorResponse } from "../types.js";
import {
  AgentNotEditableError,
  AgentNotFoundError,
  InvalidManifestError,
  mutateAgentSystemPrompt,
} from "../yaml-edit.js";

export interface RegisterAgentSystemPromptRouteOpts {
  /** Shared secret the worker presents in `Authorization: Bearer …`. */
  sharedSecret: string | null;
  /** App-level credentials minus `installationId` — supplied per-request. */
  github: Omit<GithubAppCreds, "installationId"> | null;
  deps?: {
    createOctokit?: typeof createOctokit;
  };
}

export interface AgentSystemPromptPatchBody {
  agentId: string;
  org: string;
  repo: string;
  installationId: string;
  branch?: string;
  systemPrompt: unknown;
}

const MANIFEST_PATH = "render-harness.yaml";
const MAX_PROMPT_CHARS = 50_000;

export function registerAgentSystemPromptRoute(
  app: Hono,
  opts: RegisterAgentSystemPromptRouteOpts,
): void {
  const createOctokitFn = opts.deps?.createOctokit ?? createOctokit;
  let deprecationLogged = false;

  app.patch("/api/agents/:slug/system-prompt", async (c) => {
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
    if (!deprecationLogged) {
      console.warn(
        "[deprecated] /api/agents/:slug/system-prompt via WIZARD_SHARED_SECRET. " +
          "New harnesses commit prompt edits directly via GITHUB_DEPLOY_KEY + GITHUB_DEPLOY_REPO_SSH_URL " +
          "(see docs-site/managed-repo-commits.mdx). Rotate this harness when convenient — " +
          "the wizard proxy path will be removed in a future minor cut.",
      );
      deprecationLogged = true;
    }

    let body: AgentSystemPromptPatchBody;
    try {
      body = (await c.req.json()) as AgentSystemPromptPatchBody;
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

    if (typeof body.systemPrompt !== "string") {
      return c.json<ErrorResponse>(
        { error: "invalid_system_prompt", details: "systemPrompt must be a string" },
        400,
      );
    }
    if (body.systemPrompt.trim().length === 0) {
      return c.json<ErrorResponse>(
        { error: "invalid_system_prompt", details: "systemPrompt cannot be empty" },
        400,
      );
    }
    if (body.systemPrompt.length > MAX_PROMPT_CHARS) {
      return c.json<ErrorResponse>(
        {
          error: "invalid_system_prompt",
          details: `systemPrompt exceeds ${MAX_PROMPT_CHARS.toLocaleString()} chars`,
        },
        400,
      );
    }
    const systemPrompt = body.systemPrompt;
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
      nextText = mutateAgentSystemPrompt({
        yamlText: currentText,
        agentId: body.agentId,
        systemPrompt,
      });
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return c.json<ErrorResponse>({ error: "agent_not_found", details: err.message }, 404);
      }
      if (err instanceof AgentNotEditableError) {
        return c.json(
          {
            error: "agent_not_editable",
            details: err.message,
            ...(err.entrypoint ? { entrypoint: err.entrypoint } : {}),
          },
          409,
        );
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
        message: `chore(${body.agentId}): update system prompt via operator UI`,
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
