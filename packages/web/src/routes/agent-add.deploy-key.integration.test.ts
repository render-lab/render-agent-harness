/**
 * Round-trip integration test for the deploy-key commit path on
 * `POST /agents/add`. Stands up a local bare repo seeded with a
 * single-web-agent manifest (`chat-agent`) + the matching package.json
 * + tsup.config.ts + src/main.ts, stubs `fetchImpl` to return a
 * synthetic gallery entry that adds a second agent with a `cron`
 * runtime, fires the request, and asserts everything that the wizard's
 * legacy proxy path would have done:
 *
 *   - manifest gains the new agent + (when applicable) a capabilities row
 *   - package.json gains @render-harness/runtime-cron
 *   - render.yaml gets re-emitted (and now contains a cron service)
 *   - src/cron.ts is templated in (we didn't have it before)
 *   - tsup.config.ts gains a `cron: "src/cron.ts"` entry
 *
 * Also covers two fallback paths:
 *   - wizard /api/gallery/agents/:slug returns 404 + WIZARD_SHARED_SECRET
 *     is set → falls through to the wizard-proxy path (verified by the
 *     fetchImpl call sequence).
 *   - same 404 + no WIZARD_SHARED_SECRET → 502 with an actionable
 *     `wizard_gallery_endpoint_missing` error.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentInfo } from "@render-harness/contracts";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentAddRoute } from "./agent-add.js";

const SKIP_REASON = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return null;
  } catch {
    return "git binary not on PATH";
  }
})();

// Single-agent web scaffold: name == agent id so the emitter treats it
// as single-runtime (dist/main.js). Adding a cron agent will push it
// into multi-agent territory and trigger src/cron.ts templating.
const MANIFEST_SEED = `schemaVersion: 1
name: chat-agent
description: Test single-agent chat scaffold.
harnessVersion: ^0.6
shared:
  model:
    provider: anthropic
    model: claude-sonnet-4-6
agents:
  - id: chat-agent
    agent:
      kind: builtin
      ref: chat
      systemPrompt: "you are helpful"
    runtimes:
      - kind: web
`;

const PACKAGE_SEED = `${JSON.stringify(
  {
    name: "chat-agent",
    version: "0.0.0",
    type: "module",
    dependencies: {
      "@render-harness/core": "^0.6.0",
      "@render-harness/registry": "^0.6.0",
      "@render-harness/web": "^0.6.0",
    },
  },
  null,
  2,
)}\n`;

const ENV_SEED = `ANTHROPIC_API_KEY=\nDATABASE_URL=\n`;

const TSUP_SEED = `import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
  clean: true,
  target: "node22",
});
`;

const MAIN_SEED = `export {};\n`;

// Gallery entry that adds a builtin chat agent on a cron runtime. No
// source file (builtin), no capabilities (so package.json gets only
// the runtime-cron dep through mutatePackageJsonAddRuntimeDeps).
const GALLERY_ENTRY = {
  entry: {
    slug: "research-cron",
    name: "Research cron",
    description: "Daily research",
    surface: [],
    audience: [],
    runtimeKinds: ["cron"],
    requiresHarness: null,
    capabilities: [],
    author: null,
    kind: "agent",
    manifest: {
      schemaVersion: 1,
      name: "research-cron",
      harnessVersion: "^0.6",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      agents: [
        {
          id: "research-cron",
          agent: {
            kind: "builtin",
            ref: "chat",
            systemPrompt: "Run a daily research sweep.",
          },
          runtimes: [{ kind: "cron", schedule: "0 13 * * *" }],
        },
      ],
    },
    readme: null,
    sourceFiles: {},
  },
  capabilities: [],
};

if (SKIP_REASON) {
  describe.skip(`agent-add deploy-key (${SKIP_REASON})`, () => {});
} else {
  describe("POST /agents/add (deploy_key path)", () => {
    let workspace: string;
    let bareRepoUrl: string;

    beforeAll(() => {
      workspace = mkdtempSync(join(tmpdir(), "render-harness-agent-add-"));
    });

    afterAll(() => {
      rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(() => {
      const bareDir = join(workspace, `remote-${Date.now()}-${Math.random()}.git`);
      mkdirSync(bareDir, { recursive: true });
      execSync("git init --bare --initial-branch=main", { cwd: bareDir });
      const seedDir = join(workspace, `seed-${Date.now()}-${Math.random()}`);
      mkdirSync(seedDir, { recursive: true });
      // git clone refuses to populate a non-empty directory, so we
      // clone BEFORE laying down src/ and the seed files.
      execSync(`git clone ${bareDir} ${seedDir}`, { stdio: "ignore" });
      mkdirSync(join(seedDir, "src"), { recursive: true });
      writeFileSync(join(seedDir, "render-harness.yaml"), MANIFEST_SEED);
      writeFileSync(join(seedDir, "package.json"), PACKAGE_SEED);
      writeFileSync(join(seedDir, ".env.example"), ENV_SEED);
      writeFileSync(join(seedDir, "tsup.config.ts"), TSUP_SEED);
      writeFileSync(join(seedDir, "src/main.ts"), MAIN_SEED);
      execSync("git -c user.email=t@t -c user.name=t add -A", { cwd: seedDir });
      execSync('git -c user.email=t@t -c user.name=t commit -m "seed"', { cwd: seedDir });
      execSync("git push origin HEAD:main", { cwd: seedDir });
      bareRepoUrl = `file://${bareDir}`;
    });

    interface AppOpts {
      galleryStatus?: number;
      galleryBody?: unknown;
      wizardSharedSecret?: string | null;
      env?: NodeJS.ProcessEnv;
      proxyResponse?: { status: number; body: unknown };
    }

    function buildApp(opts: AppOpts = {}): { app: Hono; fetchCalls: string[] } {
      const fetchCalls: string[] = [];
      const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        fetchCalls.push(u);
        if (u.includes("/api/gallery/agents/")) {
          if (opts.galleryStatus === 404) {
            return new Response(JSON.stringify({ error: "gallery_entry_not_found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify(opts.galleryBody ?? GALLERY_ENTRY), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (u.includes("/api/agents/add")) {
          // Wizard-proxy fallback. Echo the request body so the route
          // forwards the wizard's JSON to the operator.
          void init;
          return new Response(
            JSON.stringify(opts.proxyResponse?.body ?? { ok: true, via_wizard: true }),
            {
              status: opts.proxyResponse?.status ?? 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;

      const app = new Hono();
      const deployment: DeploymentInfo = {
        name: "chat-agent",
        description: "",
        agents: [{ id: "chat-agent", name: "chat-agent", runtimes: [{ kind: "web" }] }],
        repoLocator: {
          org: "render-lab-agents",
          repo: "test-repo",
          installationId: "12345",
          repoSshUrl: bareRepoUrl,
        },
      };
      registerAgentAddRoute(app, {
        auth: async () => "u1",
        agents: {},
        pathPrefix: "",
        deployment,
        wizardServiceUrl: "https://wizard.test",
        wizardSharedSecret: opts.wizardSharedSecret ?? null,
        fetchImpl,
        catalogCacheTtlMs: 0,
        env: opts.env ?? { GITHUB_DEPLOY_KEY: "stub-pem-not-used-for-file-protocol" },
      });
      return { app, fetchCalls };
    }

    it("commits a new cron-runtime agent end-to-end (manifest + render.yaml + src/cron.ts + tsup)", async () => {
      const { app } = buildApp();
      const res = await app.request("/agents/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleSlug: "research-cron", agentId: "research-cron" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        commitSha: string | null;
        changedFiles: string[];
        via?: string;
        warnings?: string[];
      };
      expect(body.ok).toBe(true);
      expect(body.via).toBe("deploy_key");
      expect(body.commitSha).not.toBeNull();
      expect(body.changedFiles).toEqual(
        expect.arrayContaining([
          "render-harness.yaml",
          "package.json",
          "render.yaml",
          "src/cron.ts",
          "tsup.config.ts",
        ]),
      );

      const verifyDir = join(workspace, `verify-${Date.now()}-${Math.random()}`);
      mkdirSync(verifyDir, { recursive: true });
      execSync(`git clone ${bareRepoUrl} ${verifyDir}`, { stdio: "ignore" });

      const manifest = readFileSync(join(verifyDir, "render-harness.yaml"), "utf8");
      expect(manifest).toContain("id: research-cron");
      expect(manifest).toContain("kind: cron");

      const pkg = JSON.parse(readFileSync(join(verifyDir, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      // mutatePackageJsonAddRuntimeDeps adds runtime-cron because the
      // new agent's cron runtime needs it and the project didn't have
      // it before.
      expect(pkg.dependencies["@render-harness/runtime-cron"]).toBeDefined();

      const renderYaml = readFileSync(join(verifyDir, "render.yaml"), "utf8");
      // Multi-agent now → cron service named with the agent id suffix.
      expect(renderYaml).toContain("research-cron");
      expect(renderYaml).toContain("type: cron");

      const cronEntry = readFileSync(join(verifyDir, "src/cron.ts"), "utf8");
      expect(cronEntry).toContain("runCronFromRegistryAndExit");

      const tsup = readFileSync(join(verifyDir, "tsup.config.ts"), "utf8");
      expect(tsup).toContain('"cron": "src/cron.ts"');
      // Existing main entry must be preserved verbatim.
      expect(tsup).toContain('main: "src/main.ts"');
    });

    it("falls back to the wizard-proxy path when /api/gallery/agents/:slug 404s and WIZARD_SHARED_SECRET is set", async () => {
      const { app, fetchCalls } = buildApp({
        galleryStatus: 404,
        wizardSharedSecret: "legacy-secret",
        proxyResponse: { status: 200, body: { ok: true, commitSha: "abc", changedFiles: [] } },
      });
      const res = await app.request("/agents/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleSlug: "research-cron", agentId: "research-cron" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { via?: string; commitSha?: string };
      expect(body.via).toBe("wizard_proxy");
      // The route must have tried the gallery endpoint first, then the
      // /api/agents/add proxy. Order matters: gallery probe before
      // fallback.
      expect(fetchCalls[0]).toContain("/api/gallery/agents/");
      expect(fetchCalls[1]).toContain("/api/agents/add");
    });

    it("returns 502 wizard_gallery_endpoint_missing when 404s and no WIZARD_SHARED_SECRET fallback", async () => {
      const { app } = buildApp({
        galleryStatus: 404,
        wizardSharedSecret: null,
      });
      const res = await app.request("/agents/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleSlug: "research-cron", agentId: "research-cron" }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string; details: string };
      expect(body.error).toBe("wizard_gallery_endpoint_missing");
      expect(body.details).toContain("WIZARD_SHARED_SECRET");
    });

    it("returns 503 when neither deploy-key nor wizard-shared-secret is configured", async () => {
      const { app } = buildApp({ env: {}, wizardSharedSecret: null });
      const res = await app.request("/agents/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleSlug: "research-cron", agentId: "research-cron" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; details: string };
      expect(body.error).toBe("edit_in_ui_not_configured");
      expect(body.details).toContain("GITHUB_DEPLOY_KEY");
    });
  });
}
