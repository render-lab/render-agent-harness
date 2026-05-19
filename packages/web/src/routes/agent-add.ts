/**
 * `POST /agents/add` — operator UI's Add Agent flow.
 *
 * Two commit paths, chosen at request time by `pickCommitPath`:
 *
 *   1. deploy_key — preferred. Fetches the gallery entry from the
 *      wizard's `/api/gallery/agents/:slug` (cached for 60s), clones
 *      the managed repo via SSH using the per-deployment deploy key,
 *      runs the same pure planner + mutators the wizard does
 *      server-side, re-emits `render.yaml`, writes new runtime entries
 *      / patches `tsup.config.ts` when a new runtime kind appears,
 *      commits + pushes directly. No wizard in the commit path.
 *   2. wizard_proxy — legacy. The harness forwards to the wizard's
 *      `/api/agents/add` with `Bearer WIZARD_SHARED_SECRET`. Used for
 *      harnesses that haven't rotated to the deploy-key flow yet, and
 *      as a fallback when the wizard's gallery endpoint returns 404
 *      (older wizard that pre-dates this endpoint).
 *
 * `GET /agents/catalog` always proxies the wizard — the catalog is
 * derived from `OFFICIAL_CAPABILITY_INSTALLS` which lives in the
 * wizard's deploy surface.
 */

import type { DeploymentInfo } from "@render-harness/contracts";
import type { AgentDefinition, UserId } from "@render-harness/core";
import { emitBlueprint } from "@render-harness/registry/emitter";
import type {
  ResolvedAgentEntry,
  ResolvedCapabilityEntry,
  ResolvedGallery,
} from "@render-harness/registry/gallery";
import {
  AgentAddError,
  expandAllowedToolsForPacks,
  mutateEnvExampleForAgent,
  mutateManifestForAgentAdd,
  mutatePackageJsonAddDeps,
  mutatePackageJsonAddRuntimeDeps,
  planAgentAdd,
} from "@render-harness/registry/repo-mutations";
import { ensureTsupEntries, requiredEntries } from "@render-harness/registry/runtime-entries";
import type { HarnessConfig } from "@render-harness/registry/schema";
import { parseHarnessConfigYaml } from "@render-harness/registry/schema";
import type { Context, Hono } from "hono";
import { pickCommitPath } from "../lib/commit-shim.js";
import { withRepoClone } from "../lib/git-commit.js";

export interface AgentAddRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  agents: Record<string, AgentDefinition>;
  pathPrefix: string;
  deployment?: DeploymentInfo;
  wizardServiceUrl: string | null;
  wizardSharedSecret: string | null;
  fetchImpl?: typeof fetch;
  /**
   * Override the TTL for the in-memory catalog + gallery-entry caches
   * (ms). Defaults to 60s. Tests pass 0 to disable caching.
   */
  catalogCacheTtlMs?: number;
  /**
   * Optional env source for the commit-path picker. Tests pass a fake;
   * production reads `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

const MANIFEST_PATH = "render-harness.yaml";
const PACKAGE_PATH = "package.json";
const ENV_EXAMPLE_PATH = ".env.example";
const RENDER_YAML_PATH = "render.yaml";
const TSUP_CONFIG_PATH = "tsup.config.ts";

interface GalleryEntryResponse {
  entry: ResolvedAgentEntry;
  capabilities: ResolvedCapabilityEntry[];
}

export function registerAgentAddRoute(app: Hono, ctx: AgentAddRouteContext): void {
  const { auth, pathPrefix, deployment, wizardServiceUrl, wizardSharedSecret } = ctx;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const cacheTtlMs = ctx.catalogCacheTtlMs ?? 60_000;
  const r = (path: string) => `${pathPrefix}${path}`;

  // Module-local caches keyed by wizard URL. One ServeWeb instance hosts
  // one operator UI so cardinality is 1 in practice — keying on the URL
  // just keeps the test harness happy when it varies the value.
  const catalogCache = new Map<string, { fetchedAt: number; body: string }>();
  const galleryEntryCache = new Map<string, { fetchedAt: number; payload: GalleryEntryResponse }>();

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
    const locator = deployment?.repoLocator;
    if (!locator?.org || !locator?.repo) return c.json({ error: "repo_locator_missing" }, 409);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "bad_json" }, 400);
    const bundleSlug = typeof body.bundleSlug === "string" ? body.bundleSlug : null;
    const agentId = typeof body.agentId === "string" ? body.agentId : null;
    if (!bundleSlug || !agentId) {
      return c.json({ error: "invalid_request", details: "bundleSlug + agentId required" }, 400);
    }

    const path = pickCommitPath({
      deployment,
      wizardSharedSecret,
      ...(ctx.env ? { env: ctx.env } : {}),
    });

    if (path.kind === "deploy_key") {
      // Try the deploy-key path first. If the wizard's gallery endpoint
      // doesn't exist (older wizard), fall back to the proxy path when
      // WIZARD_SHARED_SECRET is also configured. Returning a typed
      // sentinel keeps the fallback decision in one place.
      const result = await runDeployKeyAdd({
        c,
        bundleSlug,
        agentId,
        repoSshUrl: path.repoSshUrl,
        deployKeyPem: path.deployKeyPem,
        wizardServiceUrl,
        fetchImpl,
        galleryEntryCache,
        cacheTtlMs,
      });
      if (result !== "wizard_endpoint_missing") return result;
      // Fall through to proxy path below if the legacy fallback is
      // available; otherwise surface an actionable 502.
      if (!wizardSharedSecret) {
        return c.json(
          {
            error: "wizard_gallery_endpoint_missing",
            details:
              "wizard does not expose /api/gallery/agents/:slug (upgrade the wizard or set WIZARD_SHARED_SECRET to use the legacy proxy fallback)",
          },
          502,
        );
      }
    }

    if (path.kind === "deploy_key" || path.kind === "wizard_proxy") {
      return runWizardProxyAdd({
        c,
        bundleSlug,
        agentId,
        locator,
        wizardServiceUrl,
        wizardSharedSecret,
        fetchImpl,
      });
    }

    return c.json({ error: "edit_in_ui_not_configured", details: path.reason }, 503);
  });
}

/**
 * Deploy-key path. Returns a Response on success / handled error, or
 * the sentinel `"wizard_endpoint_missing"` when the wizard's gallery
 * entry endpoint 404s — the caller decides whether to fall back to the
 * proxy path or surface an actionable error.
 */
async function runDeployKeyAdd(args: {
  c: Context;
  bundleSlug: string;
  agentId: string;
  repoSshUrl: string;
  deployKeyPem: string;
  wizardServiceUrl: string | null;
  fetchImpl: typeof fetch;
  galleryEntryCache: Map<string, { fetchedAt: number; payload: GalleryEntryResponse }>;
  cacheTtlMs: number;
}): Promise<Response | "wizard_endpoint_missing"> {
  const {
    c,
    bundleSlug,
    agentId,
    repoSshUrl,
    deployKeyPem,
    wizardServiceUrl,
    fetchImpl,
    galleryEntryCache,
    cacheTtlMs,
  } = args;
  if (!wizardServiceUrl) {
    return c.json({ error: "wizard_service_not_configured" }, 503);
  }

  let galleryPayload: GalleryEntryResponse;
  try {
    const fetched = await fetchGalleryEntry({
      wizardServiceUrl,
      bundleSlug,
      fetchImpl,
      cache: galleryEntryCache,
      cacheTtlMs,
    });
    if (fetched === "not_found") {
      // Could mean: bundle slug doesn't exist OR the wizard predates
      // the gallery-entry endpoint. We can't disambiguate from the
      // 404 alone — caller falls back to the proxy path when the
      // legacy creds are present, which will tell us authoritatively
      // (gallery: bundle_not_found vs route 404).
      return "wizard_endpoint_missing";
    }
    galleryPayload = fetched;
  } catch (err) {
    return c.json(
      {
        error: "wizard_gallery_fetch_failed",
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }

  // Build a synthetic ResolvedGallery from the single-entry response.
  // Enough for planAgentAdd to resolve the entry + its cited capability
  // metadata (versionRange + envHint).
  const gallery: ResolvedGallery = {
    schemaVersion: 1,
    agents: [galleryPayload.entry],
    capabilities: galleryPayload.capabilities,
  };

  try {
    const { commit, result } = await withRepoClone({ repoSshUrl, deployKeyPem }, async (ctx) => {
      const manifestText = await ctx.readFile(MANIFEST_PATH);
      const pkgText = await ctx.readFile(PACKAGE_PATH);
      if (manifestText === null || pkgText === null) {
        throw new AgentAddError(
          "repo_layout_invalid",
          `${MANIFEST_PATH} or ${PACKAGE_PATH} missing in repo`,
        );
      }
      const envText = await ctx.readFile(ENV_EXAMPLE_PATH);
      const renderYamlText = await ctx.readFile(RENDER_YAML_PATH);

      // First plan probes for sourceFilePath; second plan re-runs
      // with the existing source content so the collision detector
      // in planAgentAdd can reject a hard mismatch before we commit.
      const probePlan = planAgentAdd({
        gallery,
        source: { bundleSlug, agentId },
        manifestText,
        existingSourceFileText: null,
      });
      const existingSourceText = probePlan.spec.sourceFilePath
        ? await ctx.readFile(probePlan.spec.sourceFilePath)
        : null;
      const finalPlan = planAgentAdd({
        gallery,
        source: { bundleSlug, agentId },
        manifestText,
        existingSourceFileText: existingSourceText,
      });

      let nextManifest = mutateManifestForAgentAdd({
        yamlText: manifestText,
        plan: finalPlan,
      });
      const allowedToolsExpansion = expandAllowedToolsForPacks({
        yamlText: nextManifest,
        packs: finalPlan.spec.capabilities.map((cap) => cap.pack),
        accessMode: "read",
      });
      nextManifest = allowedToolsExpansion.yamlText;

      let nextPkg = mutatePackageJsonAddDeps({
        jsonText: pkgText,
        capabilities: finalPlan.spec.capabilities,
      });
      const envVarNames = finalPlan.spec.envSchemaAdditions.map((e) => e.name);
      const nextEnv =
        envText !== null
          ? mutateEnvExampleForAgent({ text: envText, agentId, envVars: envVarNames })
          : null;

      let cfg: HarnessConfig;
      let nextRenderYaml: string | null = null;
      try {
        cfg = parseHarnessConfigYaml(nextManifest);
        // packageName mirrors what the wizard's route does: prefer
        // the literal `name` in package.json (which scaffold sets to
        // the operator's chosen agent name, not the manifest's
        // suffixed slug). Without this, `pnpm --filter <cfg.name>`
        // in the emitted render.yaml matches no package and the
        // build silently no-ops.
        const packageName = readPackageJsonName(pkgText) ?? cfg.name;
        const emitted = await emitBlueprint({
          config: cfg,
          packageName,
          entrypointStyle: "repo",
        });
        nextRenderYaml = emitted.yaml;
      } catch (err) {
        throw new AgentAddError(
          "blueprint_emit_failed",
          err instanceof Error ? err.message : String(err),
        );
      }

      const extraWarnings: string[] = [];
      if (allowedToolsExpansion.expanded.length > 0) {
        extraWarnings.push(
          `Expanded shared.permissions.allowedTools with read-only tools for: ${allowedToolsExpansion.expanded.join(", ")}. Use the Install capability modal to enable write tools.`,
        );
      }
      if (allowedToolsExpansion.skippedOpenAllowlist.length > 0) {
        extraWarnings.push(
          `Capabilities ${allowedToolsExpansion.skippedOpenAllowlist.join(", ")} were added but the manifest has no shared.permissions.allowedTools allowlist, so no expansion was needed.`,
        );
      }
      if (allowedToolsExpansion.skippedUnknown.length > 0) {
        extraWarnings.push(
          `Capability ${allowedToolsExpansion.skippedUnknown.join(", ")} is not in OFFICIAL_CAPABILITY_INSTALLS; allowedTools was not expanded. Add the pack to that map (with its read/write tool names) to enable auto-expansion.`,
        );
      }

      // Layer in any runtime entry files the freshly emitted
      // render.yaml will reference. Mirror's the wizard's route step
      // for step.
      const required = requiredEntries(cfg);
      const runtimeEntryWrites = new Map<string, { text: string; current: string | null }>();
      for (const entry of required) {
        const existing = await ctx.readFile(entry.sourcePath);
        if (existing === null) {
          runtimeEntryWrites.set(entry.sourcePath, {
            text: entry.template(),
            current: null,
          });
        }
      }
      const runtimePackages = required
        .map((entry) => entry.runtimePackage)
        .filter((p): p is string => p !== null);
      if (runtimePackages.length > 0) {
        nextPkg = mutatePackageJsonAddRuntimeDeps({
          jsonText: nextPkg,
          packages: runtimePackages,
        });
      }

      let tsupWrite: { text: string; current: string } | null = null;
      if (required.length > 0) {
        const tsupText = await ctx.readFile(TSUP_CONFIG_PATH);
        if (tsupText !== null) {
          const tsupResult = ensureTsupEntries(
            tsupText,
            required.map((e) => e.name),
          );
          if (!tsupResult.patched) {
            extraWarnings.push(
              `Couldn't locate the \`entry: { ... }\` block in ${TSUP_CONFIG_PATH}; add ${required
                .map((e) => `${e.name}: "${e.sourcePath}"`)
                .join(", ")} entries manually so tsup builds the new runtime(s).`,
            );
          } else if (tsupResult.changed) {
            tsupWrite = { text: tsupResult.text, current: tsupText };
          }
        } else if (runtimeEntryWrites.size > 0) {
          extraWarnings.push(
            `${TSUP_CONFIG_PATH} not found; the new runtime entry file(s) ${[
              ...runtimeEntryWrites.keys(),
            ].join(", ")} will not be built. Add a tsup.config.ts that includes them.`,
          );
        }
      }

      // Single map of every path we might touch. The `current` field
      // is what's already in the repo (null when missing) so we skip
      // no-op writes uniformly.
      type Write = { text: string; current: string | null };
      const writes = new Map<string, Write>();
      writes.set(MANIFEST_PATH, { text: nextManifest, current: manifestText });
      writes.set(PACKAGE_PATH, { text: nextPkg, current: pkgText });
      if (nextEnv && envText) {
        writes.set(ENV_EXAMPLE_PATH, { text: nextEnv, current: envText });
      }
      if (finalPlan.spec.sourceFilePath && finalPlan.spec.sourceFileContent !== null) {
        writes.set(finalPlan.spec.sourceFilePath, {
          text: finalPlan.spec.sourceFileContent,
          current: existingSourceText,
        });
      }
      for (const [path, entry] of runtimeEntryWrites) {
        writes.set(path, entry);
      }
      if (tsupWrite) {
        writes.set(TSUP_CONFIG_PATH, tsupWrite);
      }
      if (nextRenderYaml) {
        writes.set(RENDER_YAML_PATH, {
          text: nextRenderYaml,
          current: renderYamlText,
        });
      }

      let anyChange = false;
      for (const [path, write] of writes) {
        if (write.text === write.current) continue;
        await ctx.writeFile(path, write.text);
        anyChange = true;
      }
      if (!anyChange) return null;
      return {
        message: `chore: add agent ${agentId} from ${bundleSlug}`,
        result: { warnings: [...finalPlan.warnings, ...extraWarnings] },
      };
    });

    return c.json({
      ok: true,
      unchanged: commit.changedFiles.length === 0,
      commitSha: commit.commitSha,
      changedFiles: commit.changedFiles,
      warnings: result?.warnings ?? [],
      via: "deploy_key",
    });
  } catch (err) {
    if (err instanceof AgentAddError) {
      const status =
        err.code === "agent_id_exists" || err.code === "source_file_conflict"
          ? 409
          : err.code === "bundle_not_found" || err.code === "agent_not_found_in_bundle"
            ? 404
            : err.code === "blueprint_emit_failed"
              ? 400
              : 400;
      return c.json({ error: err.code, details: err.message }, status);
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

async function fetchGalleryEntry(args: {
  wizardServiceUrl: string;
  bundleSlug: string;
  fetchImpl: typeof fetch;
  cache: Map<string, { fetchedAt: number; payload: GalleryEntryResponse }>;
  cacheTtlMs: number;
}): Promise<GalleryEntryResponse | "not_found"> {
  const cacheKey = `${args.wizardServiceUrl}|${args.bundleSlug}`;
  const now = Date.now();
  const cached = args.cache.get(cacheKey);
  if (cached && args.cacheTtlMs > 0 && now - cached.fetchedAt < args.cacheTtlMs) {
    return cached.payload;
  }
  const url = `${trimTrailingSlash(args.wizardServiceUrl)}/api/gallery/agents/${encodeURIComponent(args.bundleSlug)}`;
  const res = await args.fetchImpl(url);
  if (res.status === 404) return "not_found";
  if (!res.ok) {
    throw new Error(`wizard returned ${res.status}: ${await res.text()}`);
  }
  const payload = (await res.json()) as GalleryEntryResponse;
  if (args.cacheTtlMs > 0) args.cache.set(cacheKey, { fetchedAt: now, payload });
  return payload;
}

async function runWizardProxyAdd(args: {
  c: Context;
  bundleSlug: string;
  agentId: string;
  locator: NonNullable<DeploymentInfo["repoLocator"]>;
  wizardServiceUrl: string | null;
  wizardSharedSecret: string | null;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  const { c, bundleSlug, agentId, locator, wizardServiceUrl, wizardSharedSecret, fetchImpl } = args;
  if (!wizardServiceUrl) return c.json({ error: "wizard_service_not_configured" }, 503);
  if (!wizardSharedSecret) return c.json({ error: "wizard_shared_secret_not_configured" }, 503);
  if (!locator.installationId) {
    return c.json(
      {
        error: "needs_install",
        installUrl: `${trimTrailingSlash(wizardServiceUrl)}/api/installs/start?agentSlug=agent-add`,
      },
      409,
    );
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
  const parsed = safeParseJson(text) as Record<string, unknown> | null;
  return c.json(
    parsed ? { ...parsed, via: "wizard_proxy" } : { error: "wizard_response_not_json", body: text },
    res.status as 200,
  );
}

function readPackageJsonName(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
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
