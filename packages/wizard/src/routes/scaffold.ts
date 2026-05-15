import type { ResolvedGallery } from "@render-harness/registry/gallery";
import type { Answers } from "create-render-agent";
import { buildFileMap } from "create-render-agent";
import type { Hono } from "hono";
import {
  buildDeployUrl,
  createOctokit,
  createScaffoldedRepo,
  type GithubAppCreds,
} from "../github-app.js";
import type { RateLimiter } from "../rate-limit.js";
import { verifyTurnstile } from "../turnstile.js";
import type { ErrorResponse, ScaffoldRequest, ScaffoldResponse } from "../types.js";

/**
 * Indirection for the Octokit-creating side effect so tests can inject
 * a fake Octokit + a fake repo-creator without touching real GitHub.
 */
export interface ScaffoldDeps {
  /** Authenticates as the GitHub App and returns an Octokit. */
  createOctokit: typeof createOctokit;
  /** Creates a repo + initial commit and returns its URL. */
  createScaffoldedRepo: typeof createScaffoldedRepo;
}

export interface RegisterScaffoldRouteOpts {
  org: string;
  repoPrefix: string;
  github: GithubAppCreds | null;
  turnstileSecret: string | null;
  gallery: ResolvedGallery;
  rateLimiter: RateLimiter;
  /**
   * When true, the route returns a fake repo + deploy URL without
   * touching GitHub. Used for local development (set `MOCK_SCAFFOLD=1`);
   * never set in production.
   */
  mockScaffold?: boolean;
  deps?: Partial<ScaffoldDeps>;
}

export function registerScaffoldRoute(app: Hono, opts: RegisterScaffoldRouteOpts): void {
  const deps: ScaffoldDeps = {
    createOctokit: opts.deps?.createOctokit ?? createOctokit,
    createScaffoldedRepo: opts.deps?.createScaffoldedRepo ?? createScaffoldedRepo,
  };

  app.post("/api/scaffold", async (c) => {
    const ip = clientIp(c.req.raw, c.req.header("x-forwarded-for"));

    if (!opts.rateLimiter.consume(ip)) {
      return c.json<ErrorResponse>({ error: "rate_limited" }, 429);
    }

    let body: ScaffoldRequest;
    try {
      body = (await c.req.json()) as ScaffoldRequest;
    } catch {
      return c.json<ErrorResponse>({ error: "bad_json" }, 400);
    }

    // Turnstile is best-effort: if no secret is configured (dev mode),
    // the verifier short-circuits to ok=true. Production deploys MUST
    // set the secret.
    const turnstile = await verifyTurnstile({
      secret: opts.turnstileSecret,
      token: body.turnstileToken,
      remoteIp: ip,
    });
    if (!turnstile.ok) {
      return c.json<ErrorResponse>(
        {
          error: "turnstile_failed",
          ...(turnstile.errorCodes ? { details: turnstile.errorCodes.join(",") } : {}),
        },
        400,
      );
    }

    if (!opts.github && !opts.mockScaffold) {
      return c.json<ErrorResponse>(
        {
          error: "github_not_configured",
          details:
            "GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID must be set (or set MOCK_SCAFFOLD=1 for local development)",
        },
        503,
      );
    }

    const template = body.templateSlug
      ? (opts.gallery.agents.find((a) => a.slug === body.templateSlug) ?? null)
      : null;
    const bundleEntry = body.bundleSlug
      ? (opts.gallery.agents.find((a) => a.slug === body.bundleSlug) ?? null)
      : null;

    if (body.bundleSlug && (!bundleEntry || bundleEntry.kind !== "bundle")) {
      return c.json<ErrorResponse>(
        {
          error: "bundle_not_found",
          details: `bundleSlug "${body.bundleSlug}" is not a sealed bundle in the gallery`,
        },
        400,
      );
    }

    let fileMap: Map<string, string>;
    try {
      const answers: Answers = bundleEntry
        ? {
            directory: "/managed",
            agentName: body.agentName,
            description: body.description,
            systemPrompt: "",
            model: body.model,
            runtimes: [],
            capabilities: bundleEntry.capabilities.map((pack) => ({ pack })),
            templateManifest: bundleEntry.manifest as unknown as Record<string, unknown>,
            bundle: {
              slug: bundleEntry.slug,
              manifest: bundleEntry.manifest as unknown as Record<string, unknown>,
              sourceFiles: bundleEntry.sourceFiles,
              runtimeKinds: bundleEntry.runtimeKinds,
              capabilities: bundleEntry.capabilities,
            },
            ui: bundleEntry.manifest.shared?.ui ?? false,
            packageManager: "npm",
            harnessRoot: null,
            gitInit: false,
            installDeps: false,
          }
        : {
            directory: "/managed", // placeholder; buildFileMap doesn't use it for path construction in the file map
            agentName: body.agentName,
            description: body.description,
            systemPrompt: body.systemPrompt,
            model: body.model,
            runtimes: body.runtimes,
            capabilities: body.capabilities,
            templateManifest: template
              ? (template.manifest as unknown as Record<string, unknown>)
              : null,
            bundle: null,
            ui: body.ui,
            packageManager: "npm", // managed-repo doesn't know its consumer; npm is the lowest-common-denominator default
            harnessRoot: null, // published deps, not link:
            gitInit: false,
            installDeps: false,
          };
      fileMap = buildFileMap(answers);
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "invalid_answers",
          details: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }

    if (opts.mockScaffold || !opts.github) {
      const mockSlug = applyRepoPrefix(opts.repoPrefix, `${body.agentName}-mock`);
      const mockUrl = `https://example.com/${opts.org}/${mockSlug}`;
      const response: ScaffoldResponse = {
        repoUrl: mockUrl,
        deployUrl: buildDeployUrl(mockUrl),
        repoSlug: mockSlug,
      };
      return c.json(response, 201);
    }

    try {
      const octokit = await deps.createOctokit({ creds: opts.github });
      const installationId = opts.github.installationId;
      const agentSlug = body.agentName;
      const result = await deps.createScaffoldedRepo({
        octokit,
        org: opts.org,
        desiredName: applyRepoPrefix(opts.repoPrefix, body.agentName),
        description: body.description,
        files: fileMap,
        beforeCommit: ({ org, repoName }) =>
          new Map([
            [
              ".render-harness/agent.json",
              `${JSON.stringify(
                {
                  schemaVersion: 1,
                  agentSlug,
                  org,
                  repo: repoName,
                  installationId,
                },
                null,
                2,
              )}\n`,
            ],
          ]),
      });
      const response: ScaffoldResponse = {
        repoUrl: result.repoUrl,
        deployUrl: buildDeployUrl(result.repoUrl),
        repoSlug: result.repoName,
      };
      return c.json(response, 201);
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "github_failure",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });
}

function applyRepoPrefix(prefix: string, name: string): string {
  const cleanPrefix = prefix.trim();
  if (!cleanPrefix) return name;
  return name.startsWith(cleanPrefix) ? name : `${cleanPrefix}${name}`;
}

function clientIp(req: Request, forwardedFor: string | undefined): string {
  if (forwardedFor) {
    // X-Forwarded-For can be a comma-separated chain; the first entry is
    // the original client (Render's proxy appends rather than replaces).
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  // Fall back to the connection address from the underlying socket. Hono
  // doesn't expose this directly; for dev (no proxy) Turnstile + rate
  // limit still work on a synthetic "unknown" key.
  void req;
  return "unknown";
}
