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
  mutatePackageJsonAddRuntimeDeps,
  planAgentAdd,
} from "../agent-add.js";
import { readSessionCookie } from "../auth.js";
import { createOctokit, type GithubAppCreds } from "../github-app.js";
import { ensureTsupEntries, requiredEntries } from "../runtime-entries.js";
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
const TSUP_CONFIG_PATH = "tsup.config.ts";

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
      // detect collisions without committing on conflict. For builtin
      // agents there's no source file at all — `sourceFilePath` is
      // null and we skip the probe.
      const plan = planAgentAdd({
        gallery: opts.gallery,
        source: { bundleSlug: body.bundleSlug, agentId: body.agentId },
        manifestText: manifest.text,
        existingSourceFileText: null, // probe below
      });

      const existingSource = plan.spec.sourceFilePath
        ? await readRepoFile(octokit, locator, plan.spec.sourceFilePath, branch, false)
        : null;
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
      // First add capability deps; runtime deps are layered in after
      // the Blueprint emission below so we know which runtime kinds the
      // updated manifest actually requires.
      let nextPkg = mutatePackageJsonAddDeps({
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

      let cfg: HarnessConfig;
      let nextRenderYaml: string | null = null;
      try {
        cfg = parseHarnessConfigYaml(nextManifest);
        // packageName MUST be the actual `name` field from package.json,
        // not cfg.name from the manifest. The wizard's scaffold uses
        // `body.agentName` for package.json's name but `deploymentName`
        // (a suffixed slug) for the manifest's `name`, so the two diverge
        // on every scaffold. Using cfg.name here produces a render.yaml
        // whose `pnpm --filter <cfg.name> build` matches no package,
        // silently no-ops, and leaves the dist/ tree empty — the service
        // then crashes at start with "Cannot find module dist/web.js".
        const packageName = readPackageJsonName(pkg.text) ?? cfg.name;
        const emitted = await emitBlueprint({
          config: cfg,
          packageName,
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

      const extraWarnings: string[] = [];

      // For each runtime entry the freshly emitted render.yaml will
      // reference (e.g. `dist/cron.js`), make sure `src/<name>.ts`
      // exists and the project's tsup.config.ts builds it. Without
      // this, adding a cron-runtime agent to a project that didn't
      // have a cron before leaves the cron service trying to run a
      // file the build never produced.
      const required = requiredEntries(cfg);
      const runtimeEntryWrites = new Map<
        string,
        { text: string; current: string | null; sha: string | null }
      >();
      for (const entry of required) {
        const existing = await readRepoFile(octokit, locator, entry.sourcePath, branch, false);
        if (!existing) {
          runtimeEntryWrites.set(entry.sourcePath, {
            text: entry.template(),
            current: null,
            sha: null,
          });
        }
      }

      // Layer in `@render-harness/runtime-*` deps for any runtime kind
      // newly introduced by this agent. Skipping this step makes the
      // build fail at esbuild resolve time the moment the freshly-
      // written `src/cron.ts` (or sibling) is compiled — its
      // `import "@render-harness/runtime-cron"` has no matching dep.
      const runtimePackages = required
        .map((entry) => entry.runtimePackage)
        .filter((pkgName): pkgName is string => pkgName !== null);
      if (runtimePackages.length > 0) {
        nextPkg = mutatePackageJsonAddRuntimeDeps({
          jsonText: nextPkg,
          packages: runtimePackages,
        });
      }

      let tsupWrite: { text: string; current: string; sha: string } | null = null;
      if (required.length > 0) {
        const tsup = await readRepoFile(octokit, locator, TSUP_CONFIG_PATH, branch, false);
        if (tsup) {
          const result = ensureTsupEntries(
            tsup.text,
            required.map((e) => e.name),
          );
          if (!result.patched) {
            extraWarnings.push(
              `Couldn't locate the \`entry: { ... }\` block in ${TSUP_CONFIG_PATH}; add \`${required
                .map((e) => `${e.name}: "${e.sourcePath}"`)
                .join(", ")}\` entries manually so tsup builds the new runtime(s).`,
            );
          } else if (result.changed) {
            tsupWrite = { text: result.text, current: tsup.text, sha: tsup.sha };
          }
        } else if (runtimeEntryWrites.size > 0) {
          extraWarnings.push(
            `${TSUP_CONFIG_PATH} not found; the new runtime entry file(s) ${[
              ...runtimeEntryWrites.keys(),
            ].join(", ")} will not be built. Add a tsup.config.ts that includes them.`,
          );
        }
      }

      // Single map of every path we might touch this commit. The
      // `current` field is what's already in the repo (null when the
      // file doesn't exist), so the loop below can skip no-op writes
      // for every path uniformly without a hardcoded switch.
      type Write = { text: string; current: string | null; sha: string | null };
      const writes = new Map<string, Write>();
      writes.set(MANIFEST_PATH, {
        text: nextManifest,
        current: manifest.text,
        sha: manifest.sha,
      });
      writes.set(PACKAGE_PATH, { text: nextPkg, current: pkg.text, sha: pkg.sha });
      if (nextEnv && env) {
        writes.set(ENV_EXAMPLE_PATH, { text: nextEnv, current: env.text, sha: env.sha });
      }
      if (finalPlan.spec.sourceFilePath && finalPlan.spec.sourceFileContent !== null) {
        // The planner already rejected hard conflicts. Builtin-only
        // agents have a null sourceFilePath and skip this entirely.
        writes.set(finalPlan.spec.sourceFilePath, {
          text: finalPlan.spec.sourceFileContent,
          current: existingSource?.text ?? null,
          sha: existingSource?.sha ?? null,
        });
      }
      for (const [path, entry] of runtimeEntryWrites) {
        // Runtime entry files only land when the file didn't exist —
        // never overwrite user customizations.
        writes.set(path, entry);
      }
      if (tsupWrite) {
        writes.set(TSUP_CONFIG_PATH, tsupWrite);
      }
      if (nextRenderYaml) {
        writes.set(RENDER_YAML_PATH, {
          text: nextRenderYaml,
          current: renderYaml?.text ?? null,
          sha: renderYaml?.sha ?? null,
        });
      }

      const changedFiles: string[] = [];
      let commitSha: string | null = null;
      for (const [path, next] of writes) {
        if (next.text === next.current) continue;
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
        warnings: [...finalPlan.warnings, ...extraWarnings],
      });
    } catch (err) {
      if (err instanceof AgentAddError) {
        const status =
          err.code === "agent_id_exists" || err.code === "source_file_conflict"
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

function readPackageJsonName(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
}
