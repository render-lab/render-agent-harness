/**
 * Round-trip integration test for the deploy-key commit path on
 * `PATCH /agents/:slug/system-prompt`. We stand up a local bare repo,
 * seed it with a minimal `render-harness.yaml`, point the route at the
 * `file://` URL with a stub `GITHUB_DEPLOY_KEY`, fire the request, and
 * assert that the resulting commit on `main` has the new prompt.
 *
 * Mirrors `capability-install.deploy-key.integration.test.ts` — same
 * plumbing, different mutator.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentInfo } from "@render-harness/contracts";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentSystemPromptRoute } from "./agent-system-prompt.js";

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
      systemPrompt: original
    runtimes:
      - kind: web
      - kind: worker
  - id: digest
    agent:
      kind: custom
      entrypoint: ./src/digest.ts
    runtimes:
      - kind: cron
        schedule: "0 9 * * *"
`;

if (SKIP_REASON) {
  describe.skip(`agent-system-prompt deploy-key (${SKIP_REASON})`, () => {});
} else {
  describe("PATCH /agents/:slug/system-prompt (deploy_key path)", () => {
    let workspace: string;
    let bareRepoUrl: string;

    beforeAll(() => {
      workspace = mkdtempSync(join(tmpdir(), "render-harness-prompt-route-"));
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
      execSync(`git clone ${bareDir} ${seedDir}`, { stdio: "ignore" });
      writeFileSync(join(seedDir, "render-harness.yaml"), MANIFEST_SEED);
      execSync("git -c user.email=t@t -c user.name=t add -A", { cwd: seedDir });
      execSync('git -c user.email=t@t -c user.name=t commit -m "seed"', {
        cwd: seedDir,
      });
      execSync("git push origin HEAD:main", { cwd: seedDir });
      bareRepoUrl = `file://${bareDir}`;
    });

    function buildApp(agentsOverride?: Record<string, { source?: unknown; name: string }>): Hono {
      const app = new Hono();
      const deployment: DeploymentInfo = {
        name: "test-harness",
        description: "",
        agents: [
          { id: "chat", name: "chat", runtimes: [{ kind: "web" }], workflowTask: false },
          {
            id: "digest",
            name: "digest",
            runtimes: [{ kind: "cron", schedule: "0 9 * * *", via: "cron" }],
            workflowTask: false,
          },
        ],
        repoLocator: {
          org: "render-lab-agents",
          repo: "test-repo",
          installationId: null,
          repoSshUrl: bareRepoUrl,
        },
      };
      const defaultAgents: Record<string, { source?: unknown; name: string }> = {
        chat: { name: "chat", source: { kind: "builtin" } },
        digest: {
          name: "digest",
          source: { kind: "custom", entrypoint: "./src/digest.ts" },
        },
      };
      const agents = agentsOverride ?? defaultAgents;
      registerAgentSystemPromptRoute(app, {
        auth: async () => "u1",
        agents: agents as any,
        pathPrefix: "",
        deployment,
        wizardServiceUrl: "https://wizard.test",
        wizardSharedSecret: null,
        fetchImpl: vi.fn() as unknown as typeof fetch,
        env: { GITHUB_DEPLOY_KEY: "stub-pem-not-used-for-file-protocol" },
      });
      return app;
    }

    it("commits an updated systemPrompt for a builtin agent", async () => {
      const app = buildApp();
      const newPrompt = "you are a refreshed assistant\nwith multi-line instructions";
      const res = await app.request("/agents/chat/system-prompt", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ systemPrompt: newPrompt }),
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
      expect(body.changedFiles).toEqual(["render-harness.yaml"]);

      const verifyDir = join(workspace, `verify-${Date.now()}`);
      mkdirSync(verifyDir, { recursive: true });
      execSync(`git clone ${bareRepoUrl} ${verifyDir}`, { stdio: "ignore" });
      const manifest = readFileSync(join(verifyDir, "render-harness.yaml"), "utf8");
      expect(manifest).toContain("you are a refreshed assistant");
      expect(manifest).toContain("with multi-line instructions");
      expect(manifest).not.toMatch(/systemPrompt:\s*original/);
      // The cron agent's entry stays intact.
      expect(manifest).toContain("entrypoint: ./src/digest.ts");
    });

    it("refuses kind: custom agents with a 409 and a pointer to the entrypoint", async () => {
      const app = buildApp();
      const res = await app.request("/agents/digest/system-prompt", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ systemPrompt: "nope" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; entrypoint?: string };
      expect(body.error).toBe("agent_not_editable");
      expect(body.entrypoint).toBe("./src/digest.ts");
    });

    it("rejects an empty prompt with 400", async () => {
      const app = buildApp();
      const res = await app.request("/agents/chat/system-prompt", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ systemPrompt: "   " }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_system_prompt");
    });

    it("returns 503 with actionable message when neither path is configured", async () => {
      const app = new Hono();
      registerAgentSystemPromptRoute(app, {
        auth: async () => "u1",
        agents: { chat: { name: "chat", source: { kind: "builtin" } } } as any,
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
        env: {},
      });
      const res = await app.request("/agents/chat/system-prompt", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ systemPrompt: "whatever" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; details: string };
      expect(body.error).toBe("edit_in_ui_not_configured");
      expect(body.details).toContain("GITHUB_DEPLOY_KEY");
    });
  });
}
