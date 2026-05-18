import type { Octokit } from "@octokit/rest";
import type { HarnessConfig, ResolvedAgentEntry, ResolvedGallery } from "@render-harness/registry";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { setSessionCookie } from "../auth.js";
import { createMemoryStore, type WizardStore } from "../store.js";
import { registerAgentAddRoute } from "./agent-add.js";

const SECRET = "test-secret";

const BUNDLE_MANIFEST: HarnessConfig = {
  schemaVersion: 1,
  name: "chief-of-staff",
  description: "Personal chief of staff bundle.",
  harnessVersion: "^0.1",
  shared: {
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  },
  capabilities: [{ pack: "@render-harness/cap-memory-pg" }],
  envSchema: [{ name: "CALENDAR_ICS_URL", required: false, secret: true }],
  agents: [
    {
      id: "meeting-prep",
      description: "Meeting prep cron.",
      agent: { kind: "custom", entrypoint: "./src/meeting-prep.ts" },
      runtimes: [{ kind: "cron", schedule: "*/15 * * * *" }],
    },
  ],
} as unknown as HarnessConfig;

const BUNDLE_ENTRY: ResolvedAgentEntry = {
  slug: "chief-of-staff",
  name: "Chief of Staff",
  description: "Bundle",
  categories: ["bundle"],
  runtimeKinds: ["cron"],
  requiresHarness: "^0.1",
  capabilities: ["@render-harness/cap-memory-pg"],
  author: "render-harness",
  kind: "bundle",
  manifest: BUNDLE_MANIFEST,
  readme: null,
  sourceFiles: {
    "src/meeting-prep.ts": "// meeting-prep source\n",
  },
};

const GALLERY: ResolvedGallery = {
  schemaVersion: 1,
  agents: [BUNDLE_ENTRY],
  capabilities: [
    {
      pack: "@render-harness/cap-memory-pg",
      description: "memory",
      label: "Memory (pg)",
      envHint: null,
      versionRange: "^0.1.0",
    },
  ],
};

const TARGET_YAML = `schemaVersion: 1
name: my-harness
description: existing
harnessVersion: "^0.1"
shared:
  model: { provider: anthropic, model: claude-sonnet-4-6 }
agents:
  - id: original-chat
    agent: { kind: builtin, ref: chat, systemPrompt: hi }
    runtimes:
      - kind: web
      - kind: worker
        queue: my-runs
`;

const TARGET_PKG = JSON.stringify({ name: "my-harness", dependencies: {} }, null, 2);
const TARGET_ENV = "ANTHROPIC_API_KEY=\n";
const TARGET_RENDER = "# stale render.yaml — should be re-emitted\n";

function makeApp(
  files: Record<string, string>,
  extra: { store?: WizardStore; sessionSecret?: string } = {},
) {
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error("not found"), { status: 404 });
    return {
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64"),
        sha: `${path}-sha`,
      },
    };
  });
  const createOrUpdateFileContents = vi.fn(async ({ path }: { path: string }) => ({
    data: { commit: { sha: `commit-${path}` }, content: { sha: `content-${path}` } },
  }));
  const fakeOctokit = {
    repos: { getContent, createOrUpdateFileContents },
  } as unknown as Octokit;
  const app = new Hono();
  registerAgentAddRoute(app, {
    sharedSecret: SECRET,
    github: { appId: "1", privateKey: "key" },
    gallery: GALLERY,
    ...(extra.store ? { store: extra.store } : {}),
    ...(extra.sessionSecret ? { sessionSecret: extra.sessionSecret } : {}),
    deps: { createOctokit: vi.fn(async () => fakeOctokit) },
  });
  if (extra.sessionSecret) {
    const seedSecret = extra.sessionSecret;
    app.get("/_seed-session/:id", (c) => {
      setSessionCookie(c, seedSecret, Number(c.req.param("id")));
      return c.text("ok");
    });
  }
  return { app, getContent, createOrUpdateFileContents };
}

const BODY = {
  org: "render-lab",
  repo: "my-harness",
  installationId: "123",
  bundleSlug: "chief-of-staff",
  agentId: "meeting-prep",
};

describe("POST /api/agents/add", () => {
  it("commits manifest, package, env example, source file, and re-emitted render.yaml", async () => {
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": TARGET_YAML,
      "package.json": TARGET_PKG,
      ".env.example": TARGET_ENV,
      "render.yaml": TARGET_RENDER,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; changedFiles: string[]; commitSha: string };
    expect(json.ok).toBe(true);
    // All five files changed: yaml, pkg, env, source, render.yaml.
    expect(json.changedFiles).toContain("render-harness.yaml");
    expect(json.changedFiles).toContain("package.json");
    expect(json.changedFiles).toContain(".env.example");
    expect(json.changedFiles).toContain("src/meeting-prep.ts");
    expect(json.changedFiles).toContain("render.yaml");
    expect(createOrUpdateFileContents).toHaveBeenCalledTimes(5);
  });

  it("returns 401 when bearer secret is wrong", async () => {
    const { app } = makeApp({
      "render-harness.yaml": TARGET_YAML,
      "package.json": TARGET_PKG,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(401);
  });

  it("returns 409 when bundle agent id already exists in target", async () => {
    const yamlDup = TARGET_YAML.replace("id: original-chat", "id: meeting-prep");
    const { app } = makeApp({
      "render-harness.yaml": yamlDup,
      "package.json": TARGET_PKG,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("agent_id_exists");
  });

  it("returns 404 when bundle slug is unknown", async () => {
    const { app } = makeApp({
      "render-harness.yaml": TARGET_YAML,
      "package.json": TARGET_PKG,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ ...BODY, bundleSlug: "nope" }),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("bundle_not_found");
  });

  it("session-cookie path: 403 when user does not own the target", async () => {
    const store = createMemoryStore();
    await store.upsertUser({
      githubUserId: 7,
      login: "alice",
      name: null,
      avatarUrl: null,
    });
    const { app } = makeApp(
      { "render-harness.yaml": TARGET_YAML, "package.json": TARGET_PKG },
      { store, sessionSecret: "sess-secret" },
    );
    const cookieRes = await app.request("/_seed-session/7");
    const cookie = cookieRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        bundleSlug: "chief-of-staff",
        agentId: "meeting-prep",
        targetOrg: "render-lab",
        targetRepo: "not-mine",
      }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("not_owner");
  });

  it("session-cookie path: 200 when user owns the target", async () => {
    const store = createMemoryStore();
    await store.upsertUser({
      githubUserId: 7,
      login: "alice",
      name: null,
      avatarUrl: null,
    });
    await store.addUserRepo({
      githubUserId: 7,
      org: "render-lab",
      repo: "my-harness",
      installationId: "123",
      agentSlug: "chat",
    });
    const { app } = makeApp(
      {
        "render-harness.yaml": TARGET_YAML,
        "package.json": TARGET_PKG,
        ".env.example": TARGET_ENV,
      },
      { store, sessionSecret: "sess-secret" },
    );
    const cookieRes = await app.request("/_seed-session/7");
    const cookie = cookieRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        bundleSlug: "chief-of-staff",
        agentId: "meeting-prep",
        targetOrg: "render-lab",
        targetRepo: "my-harness",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("returns 401 with no auth at all (no bearer, no session)", async () => {
    const { app } = makeApp({
      "render-harness.yaml": TARGET_YAML,
      "package.json": TARGET_PKG,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(401);
  });
});
