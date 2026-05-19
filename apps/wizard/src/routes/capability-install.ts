import type { Octokit } from "@octokit/rest";
import type { Hono } from "hono";
import {
  type CapabilityAccessMode,
  CapabilityInstallError,
  mutateCapabilityInstallYaml,
  mutateEnvExample,
  mutatePackageJsonAddDependency,
  planCapabilityInstall,
} from "../capability-install.js";
import { createOctokit, type GithubAppCreds } from "../github-app.js";
import type { ErrorResponse } from "../types.js";

export interface RegisterCapabilityInstallRouteOpts {
  sharedSecret: string | null;
  github: Omit<GithubAppCreds, "installationId"> | null;
  deps?: {
    createOctokit?: typeof createOctokit;
  };
}

interface CapabilityInstallBody {
  org: string;
  repo: string;
  installationId: string;
  branch?: string;
  agentId: string;
  pack: string;
  accessMode: CapabilityAccessMode;
  config?: Record<string, unknown>;
  requireApproval?: boolean;
}

const MANIFEST_PATH = "render-harness.yaml";
const PACKAGE_PATH = "package.json";
const ENV_EXAMPLE_PATH = ".env.example";

export function registerCapabilityInstallRoute(
  app: Hono,
  opts: RegisterCapabilityInstallRouteOpts,
): void {
  const createOctokitFn = opts.deps?.createOctokit ?? createOctokit;
  let deprecationLogged = false;

  app.post("/api/capabilities/install", async (c) => {
    if (!opts.sharedSecret)
      return c.json<ErrorResponse>({ error: "shared_secret_not_configured" }, 503);
    if (!opts.github) return c.json<ErrorResponse>({ error: "github_not_configured" }, 503);
    const auth = c.req.header("authorization") ?? "";
    if (!constantTimeEqual(auth, `Bearer ${opts.sharedSecret}`)) {
      return c.json<ErrorResponse>({ error: "unauthorized" }, 401);
    }
    if (!deprecationLogged) {
      // Logged once per wizard process — actionable hint for the
      // operator team that owns the deployed harness pinging this.
      console.warn(
        "[deprecated] /api/capabilities/install via WIZARD_SHARED_SECRET. " +
          "New harnesses commit edit-in-UI changes directly via GITHUB_DEPLOY_KEY + GITHUB_DEPLOY_REPO_SSH_URL (see docs-site/managed-repo-commits.mdx). " +
          "Rotate this harness when convenient — the wizard proxy path will be removed in a future minor cut.",
      );
      deprecationLogged = true;
    }

    let body: CapabilityInstallBody;
    try {
      body = (await c.req.json()) as CapabilityInstallBody;
    } catch {
      return c.json<ErrorResponse>({ error: "bad_json" }, 400);
    }
    if (!isValidBody(body)) {
      return c.json<ErrorResponse>({ error: "invalid_capability_install" }, 400);
    }

    const branch = body.branch ?? "main";
    let octokit: Octokit;
    try {
      octokit = await createOctokitFn({
        creds: { ...opts.github, installationId: body.installationId },
      });
    } catch (err) {
      return c.json<ErrorResponse>(
        { error: "github_auth_failed", details: err instanceof Error ? err.message : String(err) },
        502,
      );
    }

    try {
      const manifest = await readRepoFile(octokit, body, MANIFEST_PATH, branch, true);
      const pkg = await readRepoFile(octokit, body, PACKAGE_PATH, branch, true);
      const env = await readRepoFile(octokit, body, ENV_EXAMPLE_PATH, branch, false);
      if (!manifest || !pkg) {
        return c.json<ErrorResponse>({ error: "repo_or_installation_not_found" }, 409);
      }
      const plan = planCapabilityInstall({ yamlText: manifest.text, install: body });
      const nextFiles = new Map<string, { text: string; sha: string | null }>();
      nextFiles.set(MANIFEST_PATH, {
        text: mutateCapabilityInstallYaml({ yamlText: manifest.text, plan }),
        sha: manifest.sha,
      });
      nextFiles.set(PACKAGE_PATH, {
        text: mutatePackageJsonAddDependency({
          jsonText: pkg.text,
          packageName: plan.spec.pack,
          versionRange: plan.spec.versionRange,
        }),
        sha: pkg.sha,
      });
      if (env) {
        nextFiles.set(ENV_EXAMPLE_PATH, {
          text: mutateEnvExample({ text: env.text, envVars: plan.spec.envVars }),
          sha: env.sha,
        });
      }

      const changedFiles: string[] = [];
      let commitSha: string | null = null;
      for (const [path, next] of nextFiles) {
        const current =
          path === MANIFEST_PATH ? manifest.text : path === PACKAGE_PATH ? pkg.text : env?.text;
        if (next.text === current) continue;
        const result = await octokit.repos.createOrUpdateFileContents({
          owner: body.org,
          repo: body.repo,
          path,
          branch,
          message: `chore: install ${plan.spec.pack}`,
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
        warnings: plan.warnings,
      });
    } catch (err) {
      if (err instanceof CapabilityInstallError) {
        return c.json<ErrorResponse>({ error: err.code, details: err.message }, 400);
      }
      if (isOctokitError(err) && err.status === 404) {
        return c.json<ErrorResponse>(
          {
            error: "repo_or_installation_not_found",
            details: `${body.org}/${body.repo}@${branch} not reachable`,
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

async function readRepoFile(
  octokit: Octokit,
  body: Pick<CapabilityInstallBody, "org" | "repo">,
  path: string,
  branch: string,
  required: boolean,
): Promise<{ text: string; sha: string } | null> {
  try {
    const res = await octokit.repos.getContent({
      owner: body.org,
      repo: body.repo,
      path,
      ref: branch,
    });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file") throw new Error(`${path} is not a file`);
    return {
      text: Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8"),
      sha: data.sha,
    };
  } catch (err) {
    if (!required && isOctokitError(err) && err.status === 404) return null;
    throw err;
  }
}

function isValidBody(body: CapabilityInstallBody): boolean {
  return (
    typeof body.org === "string" &&
    typeof body.repo === "string" &&
    typeof body.installationId === "string" &&
    typeof body.agentId === "string" &&
    typeof body.pack === "string" &&
    (body.accessMode === "read" || body.accessMode === "read_write")
  );
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
