import type { ResolvedGallery } from "@render-harness/registry/gallery";
import type { Answers } from "create-render-agent";
import { addBlueprintFilesToMap, buildFileMap, removeLocalEnvFile } from "create-render-agent";
import type { Hono } from "hono";
import {
  buildDeployUrl,
  buildScaffoldRepoName,
  createOctokit,
  createScaffoldedRepo,
  type GithubAppCreds,
} from "../github-app.js";
import type { RateLimiter } from "../rate-limit.js";
import { verifyTurnstile } from "../turnstile.js";
import type {
  ErrorResponse,
  ScaffoldJobResponse,
  ScaffoldProgressEvent,
  ScaffoldRequest,
  ScaffoldResponse,
} from "../types.js";

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

interface ScaffoldJob {
  id: string;
  events: ScaffoldProgressEvent[];
  listeners: Set<(event: ScaffoldProgressEvent) => void>;
  done: boolean;
}

const jobs = new Map<string, ScaffoldJob>();

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

    const answers = buildAnswers({ body, template, bundleEntry });
    const job = createScaffoldJob();
    void runScaffoldJob({ job, body, answers, opts, deps });
    return c.json<ScaffoldJobResponse>({ jobId: job.id }, 202);
  });

  app.get("/api/scaffold/:jobId/stream", (c) => {
    const job = jobs.get(c.req.param("jobId"));
    if (!job) return c.json<ErrorResponse>({ error: "job_not_found" }, 404);
    return new Response(scaffoldStream(job), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}

interface BuildAnswersArgs {
  body: ScaffoldRequest;
  template: ResolvedGallery["agents"][number] | null;
  bundleEntry: ResolvedGallery["agents"][number] | null;
}

function buildAnswers({ body, template, bundleEntry }: BuildAnswersArgs): Answers {
  return bundleEntry
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
        directory: "/managed",
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
        packageManager: "npm",
        harnessRoot: null,
        gitInit: false,
        installDeps: false,
      };
}

async function runScaffoldJob(args: {
  job: ScaffoldJob;
  body: ScaffoldRequest;
  answers: Answers;
  opts: RegisterScaffoldRouteOpts;
  deps: ScaffoldDeps;
}): Promise<void> {
  const { job, body, answers, opts, deps } = args;
  try {
    emitProgress(job, "building_file_map", "Preparing the scaffolded file tree");
    const desiredName = applyRepoPrefix(opts.repoPrefix, body.agentName);
    const repoName = opts.mockScaffold ? `${desiredName}-mock` : buildScaffoldRepoName(desiredName);
    const deploymentName = toHarnessSlug(repoName);
    const fileMap = buildFileMap(answers);
    removeLocalEnvFile(fileMap);

    emitProgress(job, "generating_blueprint", "Generating render.yaml Blueprint");
    await addBlueprintFilesToMap(fileMap, body.agentName, { deploymentName });

    if (opts.mockScaffold || !opts.github) {
      const mockUrl = `https://example.com/${opts.org}/${repoName}`;
      emitDone(job, {
        repoUrl: mockUrl,
        deployUrl: buildDeployUrl(mockUrl),
        repoSlug: repoName,
      });
      return;
    }

    emitProgress(job, "authenticating_github", "Minting a GitHub App installation token");
    const octokit = await deps.createOctokit({ creds: opts.github });
    const installationId = opts.github.installationId;
    const agentSlug = body.agentName;

    emitProgress(job, "creating_repo", "Creating the private GitHub repository");
    const result = await deps.createScaffoldedRepo({
      octokit,
      org: opts.org,
      desiredName,
      repoName,
      description: body.description,
      files: fileMap,
      onProgress: (event) =>
        emitProgress(job, event.phase, event.message, {
          ...(event.index !== undefined ? { index: event.index } : {}),
          ...(event.total !== undefined ? { total: event.total } : {}),
        }),
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

    emitProgress(job, "creating_repo", "Building the Deploy to Render link");
    emitDone(job, {
      repoUrl: result.repoUrl,
      deployUrl: buildDeployUrl(result.repoUrl),
      repoSlug: result.repoName,
    });
  } catch (err) {
    const details =
      opts.github &&
      /Resource not accessible by integration/i.test(
        err instanceof Error ? err.message : String(err),
      )
        ? githubFailureDetails(err, {
            org: opts.org,
            installationId: opts.github.installationId,
            desiredName: applyRepoPrefix(opts.repoPrefix, body.agentName),
          })
        : err instanceof Error
          ? err.message
          : String(err);
    emitError(job, "scaffold_failed", details);
  }
}

function createScaffoldJob(): ScaffoldJob {
  const job: ScaffoldJob = {
    id: crypto.randomUUID(),
    events: [],
    listeners: new Set(),
    done: false,
  };
  jobs.set(job.id, job);
  setTimeout(() => jobs.delete(job.id), 15 * 60 * 1_000).unref?.();
  return job;
}

function emitProgress(
  job: ScaffoldJob,
  phase: ScaffoldProgressEvent["phase"] & string,
  message: string,
  opts: { index?: number; total?: number } = {},
): void {
  emit(job, {
    type: "progress",
    phase: phase as Exclude<ScaffoldProgressEvent["phase"], "done" | "error">,
    message,
    at: new Date().toISOString(),
    ...opts,
  });
}

function emitDone(job: ScaffoldJob, result: ScaffoldResponse): void {
  emit(job, {
    type: "done",
    phase: "done",
    message: "Repository created",
    at: new Date().toISOString(),
    result,
  });
  job.done = true;
}

function emitError(job: ScaffoldJob, error: string, details?: string): void {
  emit(job, {
    type: "error",
    phase: "error",
    message: details ? `${error}: ${details}` : error,
    at: new Date().toISOString(),
    error,
    ...(details ? { details } : {}),
  });
  job.done = true;
}

function emit(job: ScaffoldJob, event: ScaffoldProgressEvent): void {
  job.events.push(event);
  for (const listener of job.listeners) listener(event);
}

function scaffoldStream(job: ScaffoldJob): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const send = (event: ScaffoldProgressEvent) => {
        controller.enqueue(
          encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        );
        if (event.type === "done" || event.type === "error") {
          job.listeners.delete(send);
          controller.close();
        }
      };
      for (const event of job.events) send(event);
      if (!job.done) job.listeners.add(send);
    },
    cancel() {
      job.listeners.clear();
    },
  });
}

function applyRepoPrefix(prefix: string, name: string): string {
  const cleanPrefix = prefix.trim();
  if (!cleanPrefix) return name;
  return name.startsWith(cleanPrefix) ? name : `${cleanPrefix}${name}`;
}

function toHarnessSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function githubFailureDetails(
  err: unknown,
  context: { org: string; installationId: string; desiredName: string },
): string {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? `status=${String((err as { status: unknown }).status)} `
      : "";
  const message = err instanceof Error ? err.message : String(err);
  const target = `target=POST /orgs/${context.org}/repos desiredName=${context.desiredName} installationId=${context.installationId}`;
  if (/Resource not accessible by integration/i.test(message)) {
    return `${status}${message}. ${target}. The GitHub App installation token still cannot create repositories in this org. Verify the app installation on ${context.org} has Repository permissions > Administration: Read and write, Repository permissions > Contents: Read and write, access to all repositories, and no pending org approval for changed permissions.`;
  }
  return `${status}${message}. ${target}.`;
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
