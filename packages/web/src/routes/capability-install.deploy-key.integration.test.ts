/**
 * Round-trip integration test for the deploy-key commit path on
 * `POST /capabilities/install`. We stand up a local bare repo, seed it
 * with a minimal `render-harness.yaml` + `package.json` + `.env.example`,
 * point the route at the `file://` URL with a stub `GITHUB_DEPLOY_KEY`,
 * fire the request, and assert the resulting commit on `main`.
 *
 * Tests the same simple-git plumbing as
 * `lib/git-commit.integration.test.ts` plus the route-level wiring:
 * shim selection, planner invocation, mutator output, and the JSON
 * envelope returned to the operator UI.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentInfo } from "@render-harness/contracts";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCapabilityInstallRoute } from "./capability-install.js";

const SKIP_REASON = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return null;
  } catch {
    return "git binary not on PATH";
  }
})();

const MANIFEST_SEED = `# Test harness manifest
name: test-harness
harnessVersion: ^0.6
agents:
  - id: chat
    agent:
      kind: builtin
      ref: chat
      systemPrompt: ""
    runtimes:
      - kind: web
      - kind: worker
`;

const PACKAGE_SEED = `${JSON.stringify(
  {
    name: "test-harness",
    version: "0.0.0",
    type: "module",
    dependencies: {},
  },
  null,
  2,
)}\n`;

const ENV_SEED = `ANTHROPIC_API_KEY=\nDATABASE_URL=\n`;

if (SKIP_REASON) {
  describe.skip(`capability-install deploy-key (${SKIP_REASON})`, () => {});
} else {
  describe("POST /capabilities/install (deploy_key path)", () => {
    let workspace: string;
    let bareRepoUrl: string;

    beforeAll(() => {
      workspace = mkdtempSync(join(tmpdir(), "render-harness-route-"));
    });

    afterAll(() => {
      rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(() => {
      // Fresh bare repo per test so order-independent assertions hold.
      const bareDir = join(workspace, `remote-${Date.now()}-${Math.random()}.git`);
      mkdirSync(bareDir, { recursive: true });
      execSync("git init --bare --initial-branch=main", { cwd: bareDir });
      const seedDir = join(workspace, `seed-${Date.now()}-${Math.random()}`);
      mkdirSync(seedDir, { recursive: true });
      execSync(`git clone ${bareDir} ${seedDir}`, { stdio: "ignore" });
      writeFileSync(join(seedDir, "render-harness.yaml"), MANIFEST_SEED);
      writeFileSync(join(seedDir, "package.json"), PACKAGE_SEED);
      writeFileSync(join(seedDir, ".env.example"), ENV_SEED);
      execSync("git -c user.email=t@t -c user.name=t add -A", { cwd: seedDir });
      execSync('git -c user.email=t@t -c user.name=t commit -m "seed"', {
        cwd: seedDir,
      });
      execSync("git push origin HEAD:main", { cwd: seedDir });
      bareRepoUrl = `file://${bareDir}`;
    });

    function buildApp(): Hono {
      const app = new Hono();
      const deployment: DeploymentInfo = {
        name: "test-harness",
        description: "",
        agents: [{ id: "chat", name: "chat", runtimes: [{ kind: "web" }] }],
        repoLocator: {
          org: "render-lab-agents",
          repo: "test-repo",
          installationId: null,
          repoSshUrl: bareRepoUrl,
        },
      };
      registerCapabilityInstallRoute(app, {
        auth: async () => "u1",
        agents: {
          chat: { name: "chat" } as any,
        },
        pathPrefix: "",
        deployment,
        wizardServiceUrl: "https://wizard.test",
        wizardSharedSecret: null,
        fetchImpl: vi.fn() as unknown as typeof fetch,
        catalogCacheTtlMs: 0,
        env: { GITHUB_DEPLOY_KEY: "stub-pem-not-used-for-file-protocol" },
      });
      return app;
    }

    it("commits manifest + package.json + .env.example for a fresh capability install", async () => {
      const app = buildApp();
      const res = await app.request("/capabilities/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "chat",
          pack: "@render-harness/cap-memory-pg",
          accessMode: "read",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        commitSha: string | null;
        changedFiles: string[];
        via?: string;
      };
      expect(body.ok).toBe(true);
      expect(body.via).toBe("deploy_key");
      expect(body.commitSha).not.toBeNull();
      expect(body.changedFiles).toEqual(
        expect.arrayContaining(["render-harness.yaml", "package.json"]),
      );

      // Verify the bare repo actually received the changes.
      const verifyDir = join(workspace, `verify-${Date.now()}`);
      mkdirSync(verifyDir, { recursive: true });
      execSync(`git clone ${bareRepoUrl} ${verifyDir}`, { stdio: "ignore" });
      const manifest = readFileSync(join(verifyDir, "render-harness.yaml"), "utf8");
      expect(manifest).toContain("@render-harness/cap-memory-pg");
      const pkg = JSON.parse(readFileSync(join(verifyDir, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      expect(pkg.dependencies["@render-harness/cap-memory-pg"]).toBeDefined();
    });

    it("returns 503 with actionable message when neither path is configured", async () => {
      const app = new Hono();
      registerCapabilityInstallRoute(app, {
        auth: async () => "u1",
        agents: {
          chat: { name: "chat" } as any,
        },
        pathPrefix: "",
        deployment: {
          name: "test-harness",
          description: "",
          agents: [],
          repoLocator: { org: "x", repo: "y", installationId: null },
        },
        wizardServiceUrl: "https://wizard.test",
        wizardSharedSecret: null,
        fetchImpl: vi.fn() as unknown as typeof fetch,
        env: {}, // no GITHUB_DEPLOY_KEY
      });
      const res = await app.request("/capabilities/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "chat",
          pack: "@render-harness/cap-memory-pg",
          accessMode: "read",
        }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; details: string };
      expect(body.error).toBe("edit_in_ui_not_configured");
      expect(body.details).toContain("GITHUB_DEPLOY_KEY");
    });
  });
}
