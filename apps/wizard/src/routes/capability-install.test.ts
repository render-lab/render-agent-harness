import type { Octokit } from "@octokit/rest";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerCapabilityInstallRoute } from "./capability-install.js";

const SECRET = "test-secret";
const YAML = `schemaVersion: 1
name: support-bot
description: x
harnessVersion: "^0.1"
shared:
  model: { provider: anthropic, model: claude-sonnet-4-6 }
agents:
  - id: support-bot
    agent: { kind: builtin, ref: chat, systemPrompt: hi }
    runtimes:
      - kind: web
      - kind: worker
        queue: support-runs
`;

function makeApp(files: Record<string, string> = {}) {
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
  const createOrUpdateFileContents = vi.fn(async () => ({
    data: { commit: { sha: "commit-sha" }, content: { sha: "content-sha" } },
  }));
  const fakeOctokit = { repos: { getContent, createOrUpdateFileContents } } as unknown as Octokit;
  const app = new Hono();
  registerCapabilityInstallRoute(app, {
    sharedSecret: SECRET,
    github: { appId: "1", privateKey: "key" },
    deps: { createOctokit: vi.fn(async () => fakeOctokit) },
  });
  return { app, getContent, createOrUpdateFileContents };
}

const BODY = {
  org: "render-lab",
  repo: "support-bot",
  installationId: "123",
  agentId: "support-bot",
  pack: "@render-harness/cap-slack",
  accessMode: "read_write",
};

describe("POST /api/capabilities/install", () => {
  it("commits manifest, package, and env example updates", async () => {
    const { app, createOrUpdateFileContents } = makeApp({
      "render-harness.yaml": YAML,
      "package.json": JSON.stringify({ dependencies: {} }),
      ".env.example": "ANTHROPIC_API_KEY=\n",
    });
    const res = await app.request("/api/capabilities/install", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; changedFiles: string[] };
    expect(json.ok).toBe(true);
    expect(json.changedFiles).toEqual(["render-harness.yaml", "package.json", ".env.example"]);
    expect(createOrUpdateFileContents).toHaveBeenCalledTimes(3);
  });

  it("rejects connector installs without worker runtime", async () => {
    const { app } = makeApp({
      "render-harness.yaml": YAML.replace(/ {6}- kind: worker\n {8}queue: support-runs\n/, ""),
      "package.json": JSON.stringify({ dependencies: {} }),
    });
    const res = await app.request("/api/capabilities/install", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ ...BODY, accessMode: "read" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("missing_worker_runtime");
  });
});
