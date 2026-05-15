import type { Octokit } from "@octokit/rest";
import type { ResolvedGallery } from "@render-harness/registry/gallery";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../rate-limit.js";
import { registerScaffoldRoute } from "./scaffold.js";

const EMPTY_GALLERY: ResolvedGallery = {
  schemaVersion: 1,
  agents: [],
  capabilities: [],
};

function makeApp(overrides?: {
  github?: Parameters<typeof registerScaffoldRoute>[1]["github"];
  createScaffoldedRepo?: ReturnType<typeof vi.fn>;
}) {
  const app = new Hono();
  const createScaffoldedRepo =
    overrides?.createScaffoldedRepo ??
    vi.fn(async () => ({
      repoName: "my-agent-aaaa",
      repoUrl: "https://github.com/render-lab-agents/my-agent-aaaa",
      commitSha: "deadbeef",
    }));
  registerScaffoldRoute(app, {
    org: "render-lab-agents",
    repoPrefix: "RAH-",
    github:
      overrides?.github === undefined
        ? { appId: "1", privateKey: "key", installationId: "2" }
        : overrides.github,
    turnstileSecret: null,
    gallery: EMPTY_GALLERY,
    rateLimiter: createRateLimiter({ capacity: 100, windowMs: 60_000 }),
    deps: {
      createOctokit: vi.fn(async () => ({}) as unknown as Octokit),
      createScaffoldedRepo,
    },
  });
  return { app, createScaffoldedRepo };
}

const VALID_BODY = {
  agentName: "my-agent",
  description: "A test agent.",
  systemPrompt: "You are helpful.",
  model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  runtimes: [{ kind: "web" }],
  capabilities: [],
  ui: false,
  templateSlug: null,
  bundleSlug: null,
  turnstileToken: "",
};

async function startScaffold(app: Hono, body: unknown = VALID_BODY): Promise<string> {
  const res = await app.request("/api/scaffold", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  const parsed = (await res.json()) as { jobId: string };
  expect(parsed.jobId).toBeTruthy();
  return parsed.jobId;
}

async function readScaffoldEvents(
  app: Hono,
  jobId: string,
): Promise<Array<Record<string, unknown>>> {
  const stream = await app.request(`/api/scaffold/${jobId}/stream`);
  expect(stream.status).toBe(200);
  const text = await stream.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("POST /api/scaffold", () => {
  it("creates a managed repo and returns deploy URL", async () => {
    const { app, createScaffoldedRepo } = makeApp();
    const jobId = await startScaffold(app);
    const events = await readScaffoldEvents(app, jobId);
    const done = events.find((event) => event.type === "done") as
      | { result?: { repoUrl: string; deployUrl: string; repoSlug: string } }
      | undefined;
    expect(done?.result?.repoUrl).toBe("https://github.com/render-lab-agents/my-agent-aaaa");
    expect(done?.result?.deployUrl).toContain("render.com/deploy");
    expect(done?.result?.repoSlug).toBe("my-agent-aaaa");
    expect(createScaffoldedRepo).toHaveBeenCalledTimes(1);
    expect(createScaffoldedRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredName: "RAH-my-agent",
        repoName: expect.stringMatching(/^RAH-my-agent-[0-9a-f]{4}$/),
      }),
    );

    // Confirm the file map contains the expected files.
    const call = createScaffoldedRepo.mock.calls[0]?.[0] as { files: Map<string, string> };
    expect(call.files.has("render-harness.yaml")).toBe(true);
    expect(call.files.has("render.yaml")).toBe(true);
    expect(call.files.has("package.json")).toBe(true);
    expect(call.files.has("src/main.ts")).toBe(true);
    expect(call.files.get("render.yaml")).toContain("services:");
    expect(call.files.get("render-harness.yaml")).toMatch(/name: RAH-my-agent-[0-9a-f]{4}/);
    expect(call.files.get("render.yaml")).toMatch(/name: RAH-my-agent-[0-9a-f]{4}/);
  });

  it("returns 503 when GitHub App credentials are missing", async () => {
    const { app } = makeApp({ github: null });
    const res = await app.request("/api/scaffold", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("github_not_configured");
  });

  it("returns actionable details when GitHub rejects repo creation", async () => {
    const err = Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
    const { app } = makeApp({
      createScaffoldedRepo: vi.fn(async () => {
        throw err;
      }),
    });
    const jobId = await startScaffold(app);
    const events = await readScaffoldEvents(app, jobId);
    const error = events.find((event) => event.type === "error") as
      | { details?: string; error?: string }
      | undefined;
    expect(error?.error).toBe("scaffold_failed");
    expect(error?.details).toContain("POST /orgs/render-lab-agents/repos");
    expect(error?.details).toContain("installationId=2");
    expect(error?.details).toContain("Administration: Read and write");
  });

  it("returns 400 for invalid JSON", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/scaffold", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the answers fail schema validation", async () => {
    const { app } = makeApp();
    const jobId = await startScaffold(app, { ...VALID_BODY, agentName: "" });
    const events = await readScaffoldEvents(app, jobId);
    expect(events.find((event) => event.type === "error")).toBeDefined();
  });

  it("emits a complete openai-compat model block when the body carries a custom spec", async () => {
    const { app, createScaffoldedRepo } = makeApp();
    await startScaffold(app, {
      ...VALID_BODY,
      model: {
        provider: "openai-compat",
        model: "openai/gpt-4o",
        baseURL: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
    });
    const call = createScaffoldedRepo.mock.calls[0]?.[0] as { files: Map<string, string> };
    const yaml = call.files.get("render-harness.yaml") ?? "";
    expect(yaml).toContain("provider: openai-compat");
    expect(yaml).toContain("model: openai/gpt-4o");
    expect(yaml).toContain("baseURL: https://openrouter.ai/api/v1");
    expect(yaml).toContain("apiKeyEnv: OPENROUTER_API_KEY");
  });

  it("rate-limits per IP", async () => {
    const app = new Hono();
    const limiter = createRateLimiter({ capacity: 1, windowMs: 60_000 });
    registerScaffoldRoute(app, {
      org: "render-lab-agents",
      repoPrefix: "RAH-",
      github: { appId: "1", privateKey: "key", installationId: "2" },
      turnstileSecret: null,
      gallery: EMPTY_GALLERY,
      rateLimiter: limiter,
      deps: {
        createOctokit: vi.fn(async () => ({}) as unknown as Octokit),
        createScaffoldedRepo: vi.fn(async () => ({
          repoName: "x",
          repoUrl: "https://x",
          commitSha: "0",
        })),
      },
    });
    const opts = {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify(VALID_BODY),
    };
    const first = await app.request("/api/scaffold", opts);
    expect(first.status).toBe(202);
    const second = await app.request("/api/scaffold", opts);
    expect(second.status).toBe(429);
  });
});
