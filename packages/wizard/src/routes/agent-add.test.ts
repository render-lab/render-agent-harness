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

const SINGLE_AGENT_MANIFEST: HarnessConfig = {
  schemaVersion: 1,
  name: "chat",
  description: "Single-turn HTTP chat.",
  harnessVersion: "^0.2",
  shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
  agents: [
    {
      id: "chat-agent",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "hi" },
      runtimes: [{ kind: "web" }],
    },
  ],
} as unknown as HarnessConfig;

const SINGLE_AGENT_ENTRY: ResolvedAgentEntry = {
  slug: "chat",
  name: "Chat",
  description: "Single-turn HTTP chat.",
  categories: [],
  runtimeKinds: ["web"],
  requiresHarness: "^0.2",
  capabilities: [],
  author: "render-harness",
  kind: "agent",
  manifest: SINGLE_AGENT_MANIFEST,
  readme: null,
  sourceFiles: {},
};

const GALLERY: ResolvedGallery = {
  schemaVersion: 1,
  agents: [BUNDLE_ENTRY, SINGLE_AGENT_ENTRY],
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

// Pre-existing runtime entry files for the TARGET project. The target
// harness is web+worker (see TARGET_YAML), so its scaffold ships these
// alongside a tsup.config.ts that builds both. Tests that don't seed
// these will also see runtime-entry writes — see the dedicated
// runtime-entries describe block below for those scenarios.
const TARGET_TSUP = `import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    web: "src/web.ts",
    worker: "src/worker.ts",
  },
  format: ["esm"],
});
`;
const TARGET_WEB_TS = "// existing web entry\n";
const TARGET_WORKER_TS = "// existing worker entry\n";

describe("POST /api/agents/add", () => {
  it("commits manifest, package, env example, source file, and re-emitted render.yaml", async () => {
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": TARGET_YAML,
      "package.json": TARGET_PKG,
      ".env.example": TARGET_ENV,
      "render.yaml": TARGET_RENDER,
      "tsup.config.ts": TARGET_TSUP,
      "src/web.ts": TARGET_WEB_TS,
      "src/worker.ts": TARGET_WORKER_TS,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; changedFiles: string[]; commitSha: string };
    expect(json.ok).toBe(true);
    // Six files: yaml, pkg, env, custom-agent source, render.yaml, and
    // a new src/cron.ts plus a tsup.config.ts patch for the cron entry
    // the bundle introduces.
    expect(json.changedFiles).toContain("render-harness.yaml");
    expect(json.changedFiles).toContain("package.json");
    expect(json.changedFiles).toContain(".env.example");
    expect(json.changedFiles).toContain("src/meeting-prep.ts");
    expect(json.changedFiles).toContain("render.yaml");
    expect(json.changedFiles).toContain("src/cron.ts");
    expect(json.changedFiles).toContain("tsup.config.ts");
    expect(createOrUpdateFileContents).toHaveBeenCalledTimes(7);
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

  it("commits a builtin (no entrypoint) gallery entry without writing the bundle's own source file", async () => {
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": TARGET_YAML,
      "package.json": TARGET_PKG,
      "render.yaml": TARGET_RENDER,
      "tsup.config.ts": TARGET_TSUP,
      "src/web.ts": TARGET_WEB_TS,
      "src/worker.ts": TARGET_WORKER_TS,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        ...BODY,
        bundleSlug: "chat",
        agentId: "chat-agent",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; changedFiles: string[] };
    expect(json.ok).toBe(true);
    expect(json.changedFiles).toContain("render-harness.yaml");
    // The builtin agent itself ships no entrypoint, so its `src/<id>.ts`
    // is never written.
    const paths = createOrUpdateFileContents.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(paths).not.toContain("src/chat-agent.ts");
    expect(paths).not.toContain("src/chat.ts");
    // Adding a builtin web-only agent to a project that already has
    // web/worker runtime entries introduces no new runtime kinds either.
    expect(paths).not.toContain("src/cron.ts");
    expect(paths).not.toContain("tsup.config.ts");
  });

  it("uses the package.json name (not cfg.name) in the regenerated render.yaml's pnpm filter", async () => {
    // Mirrors the live wizard scaffold, which writes a deployment-suffixed
    // `name` into render-harness.yaml but keeps the original `name` in
    // package.json. Without this regression the regenerated render.yaml
    // calls `pnpm --filter <deploymentName> build`, which matches no
    // package and silently no-ops — leaving dist/ empty and crashing the
    // service at start with "Cannot find module dist/web.js".
    const deployedYaml = TARGET_YAML.replace("name: my-harness", "name: my-harness-ab12");
    const userPkg = JSON.stringify({ name: "my-harness", dependencies: {} }, null, 2);
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": deployedYaml,
      "package.json": userPkg,
      "render.yaml": TARGET_RENDER,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        ...BODY,
        bundleSlug: "chat",
        agentId: "chat-agent",
      }),
    });
    expect(res.status).toBe(200);
    const renderYamlCall = createOrUpdateFileContents.mock.calls.find(
      (c) => (c[0] as { path: string }).path === "render.yaml",
    );
    expect(renderYamlCall).toBeDefined();
    const committedRenderYaml = Buffer.from(
      (renderYamlCall?.[0] as { content: string }).content,
      "base64",
    ).toString("utf8");
    expect(committedRenderYaml).toContain("pnpm --filter my-harness build");
    expect(committedRenderYaml).not.toContain("pnpm --filter my-harness-ab12 build");
  });

  it("adding a cron agent to a single-runtime web project writes src/cron.ts and appends a cron entry to tsup", async () => {
    // Single-runtime web project: src/main.ts is the only source, tsup
    // ships `{ main: "src/main.ts" }`, render.yaml's web service runs
    // `node dist/main.js`. Adding meeting-prep (cron) introduces a cron
    // runtime — the regenerated render.yaml will reference dist/cron.js
    // (singleAgent flips to false), so the wizard must write src/cron.ts
    // AND append `cron: "src/cron.ts"` to tsup. Without this fix, the
    // cron service crashes at start with "Cannot find module dist/cron.js".
    const singleRuntimeYaml = `schemaVersion: 1
name: chat
description: Single-turn HTTP chat.
harnessVersion: "^0.2"
shared:
  model: { provider: anthropic, model: claude-sonnet-4-6 }
agents:
  - id: chat-agent
    agent: { kind: builtin, ref: chat, systemPrompt: hi }
    runtimes:
      - kind: web
`;
    const singleRuntimeTsup = `import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
});
`;
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": singleRuntimeYaml,
      "package.json": JSON.stringify({ name: "chat", dependencies: {} }, null, 2),
      "render.yaml": TARGET_RENDER,
      "tsup.config.ts": singleRuntimeTsup,
      "src/main.ts": "// existing single-runtime entry\n",
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; changedFiles: string[] };
    expect(json.changedFiles).toContain("src/cron.ts");
    expect(json.changedFiles).toContain("tsup.config.ts");
    // The pre-existing src/main.ts is left alone (we never overwrite a
    // user-authored runtime entry).
    expect(json.changedFiles).not.toContain("src/main.ts");

    const calls = createOrUpdateFileContents.mock.calls.map(
      (c) =>
        c[0] as {
          path: string;
          content: string;
        },
    );
    const cronWrite = calls.find((c) => c.path === "src/cron.ts");
    expect(cronWrite).toBeDefined();
    const cronBody = Buffer.from(cronWrite?.content, "base64").toString("utf8");
    expect(cronBody).toContain("runCronFromRegistryAndExit");
    expect(cronBody).toContain("HARNESS_AGENT_ID");

    const tsupWrite = calls.find((c) => c.path === "tsup.config.ts");
    expect(tsupWrite).toBeDefined();
    const tsupBody = Buffer.from(tsupWrite?.content, "base64").toString("utf8");
    // Original `main` entry preserved verbatim, cron appended.
    expect(tsupBody).toContain('main: "src/main.ts"');
    expect(tsupBody).toContain('"cron": "src/cron.ts"');
  });

  it("adding a cron agent to a multi-runtime web+worker project appends only the missing cron entry", async () => {
    // Starts from TARGET (web+worker, tsup `{ web, worker }`). Adding
    // meeting-prep (cron) should add src/cron.ts and append `cron` to
    // the tsup entry block, without touching the existing web/worker
    // entries.
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": TARGET_YAML,
      "package.json": TARGET_PKG,
      "render.yaml": TARGET_RENDER,
      "tsup.config.ts": TARGET_TSUP,
      "src/web.ts": TARGET_WEB_TS,
      "src/worker.ts": TARGET_WORKER_TS,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; changedFiles: string[] };
    expect(json.changedFiles).toContain("src/cron.ts");
    expect(json.changedFiles).toContain("tsup.config.ts");
    expect(json.changedFiles).not.toContain("src/web.ts");
    expect(json.changedFiles).not.toContain("src/worker.ts");

    const calls = createOrUpdateFileContents.mock.calls.map(
      (c) =>
        c[0] as {
          path: string;
          content: string;
        },
    );
    const tsupWrite = calls.find((c) => c.path === "tsup.config.ts");
    expect(tsupWrite).toBeDefined();
    const tsupBody = Buffer.from(tsupWrite?.content, "base64").toString("utf8");
    expect(tsupBody).toContain('web: "src/web.ts"');
    expect(tsupBody).toContain('worker: "src/worker.ts"');
    expect(tsupBody).toContain('"cron": "src/cron.ts"');
  });

  it("skips the src/cron.ts write when the file already exists in the repo", async () => {
    const existingCron = "// user-customized cron entry — must not be overwritten\n";
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": TARGET_YAML,
      "package.json": TARGET_PKG,
      "render.yaml": TARGET_RENDER,
      "tsup.config.ts": TARGET_TSUP.replace(
        'worker: "src/worker.ts",',
        'worker: "src/worker.ts",\n    cron: "src/cron.ts",',
      ),
      "src/web.ts": TARGET_WEB_TS,
      "src/worker.ts": TARGET_WORKER_TS,
      "src/cron.ts": existingCron,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; changedFiles: string[] };
    expect(json.changedFiles).not.toContain("src/cron.ts");
    expect(json.changedFiles).not.toContain("tsup.config.ts");
    const paths = createOrUpdateFileContents.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(paths).not.toContain("src/cron.ts");
  });

  it("expands shared.permissions.allowedTools (with Tier A) when the bundle pulls in a cap into a restrictive agent", async () => {
    // Target manifest is the same support-bot-style web+worker layout as
    // the rest of this file's fixtures, but ships a non-empty
    // allowedTools — exactly the case where the wizard SHOULD grow
    // the allowlist with the new cap's read tools + Tier A.
    const restrictiveYaml = `${TARGET_YAML.replace(
      "shared:\n  model: { provider: anthropic, model: claude-sonnet-4-6 }",
      `shared:
  model: { provider: anthropic, model: claude-sonnet-4-6 }
  permissions:
    allowedTools:
      - cap-slack__slack_get_thread`,
    )}`;
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": restrictiveYaml,
      "package.json": TARGET_PKG,
      "render.yaml": TARGET_RENDER,
      "tsup.config.ts": TARGET_TSUP,
      "src/web.ts": TARGET_WEB_TS,
      "src/worker.ts": TARGET_WORKER_TS,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; warnings: string[] };
    expect(json.ok).toBe(true);
    expect(json.warnings.some((w) => w.includes("allowedTools"))).toBe(true);

    const manifestWrite = createOrUpdateFileContents.mock.calls.find(
      (c) => (c[0] as { path: string }).path === "render-harness.yaml",
    );
    expect(manifestWrite).toBeDefined();
    const committedYaml = Buffer.from(
      (manifestWrite?.[0] as { content: string }).content,
      "base64",
    ).toString("utf8");
    // cap-memory-pg read tool name lands.
    expect(committedYaml).toContain("cap-memory-pg__search");
    // Tier A builtins land alongside so load_skill / fetch_url still work.
    expect(committedYaml).toContain("load_skill");
    expect(committedYaml).toContain("fetch_url");
  });

  it("does NOT introduce an allowlist when the agent had no allowedTools", async () => {
    // TARGET_YAML doesn't declare allowedTools; the cap-add must not
    // introduce one (otherwise it strips every other tool the agent had).
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": TARGET_YAML,
      "package.json": TARGET_PKG,
      "render.yaml": TARGET_RENDER,
      "tsup.config.ts": TARGET_TSUP,
      "src/web.ts": TARGET_WEB_TS,
      "src/worker.ts": TARGET_WORKER_TS,
    });
    const res = await app.request("/api/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    const manifestWrite = createOrUpdateFileContents.mock.calls.find(
      (c) => (c[0] as { path: string }).path === "render-harness.yaml",
    );
    const committedYaml = Buffer.from(
      (manifestWrite?.[0] as { content: string }).content,
      "base64",
    ).toString("utf8");
    expect(committedYaml).not.toMatch(/^\s*allowedTools:/m);
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
