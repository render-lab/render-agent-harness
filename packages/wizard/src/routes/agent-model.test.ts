import type { Octokit } from "@octokit/rest";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAgentModelRoute } from "./agent-model.js";

const SECRET = "test-shared-secret";
const SAMPLE_YAML = `schemaVersion: 1
name: my-agent
description: x
harnessVersion: ^0.1
license: MIT
shared:
  model:
    provider: anthropic
    model: claude-sonnet-4-6
agents:
  - id: my-agent
    agent:
      kind: builtin
      ref: chat
      systemPrompt: hi
    model:
      provider: anthropic
      model: claude-sonnet-4-6
    runtimes:
      - kind: web
        plan: starter
`;

function makeApp(overrides?: {
  getContent?: ReturnType<typeof vi.fn>;
  createOrUpdate?: ReturnType<typeof vi.fn>;
  github?: { appId: string; privateKey: string } | null;
}) {
  const app = new Hono();
  const getContent =
    overrides?.getContent ??
    vi.fn(async () => ({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(SAMPLE_YAML, "utf8").toString("base64"),
        sha: "originalsha",
      },
    }));
  const createOrUpdate =
    overrides?.createOrUpdate ??
    vi.fn(async () => ({
      data: {
        commit: { sha: "newcommitsha" },
        content: { sha: "newcontentsha" },
      },
    }));
  const fakeOctokit = {
    repos: {
      getContent,
      createOrUpdateFileContents: createOrUpdate,
    },
  } as unknown as Octokit;

  registerAgentModelRoute(app, {
    sharedSecret: SECRET,
    github: overrides?.github === undefined ? { appId: "1", privateKey: "key" } : overrides.github,
    deps: { createOctokit: vi.fn(async () => fakeOctokit) },
  });
  return { app, getContent, createOrUpdate };
}

const VALID_BODY = {
  agentId: "my-agent",
  org: "render-lab-agents",
  repo: "my-agent-aaaa",
  installationId: "12345",
  spec: {
    provider: "openai-compat",
    model: "openai/gpt-4o",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
};

describe("PATCH /api/agents/:slug/model", () => {
  it("commits an updated manifest to main", async () => {
    const { app, getContent, createOrUpdate } = makeApp();
    const res = await app.request("/api/agents/my-agent/model", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; commitSha: string };
    expect(body.ok).toBe(true);
    expect(body.commitSha).toBe("newcommitsha");

    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "render-lab-agents",
        repo: "my-agent-aaaa",
        path: "render-harness.yaml",
        ref: "main",
      }),
    );

    const writeCall = createOrUpdate.mock.calls[0]?.[0] as {
      sha: string;
      content: string;
      message: string;
    };
    expect(writeCall.sha).toBe("originalsha");
    expect(writeCall.message).toMatch(/my-agent.*model/);
    const written = Buffer.from(writeCall.content, "base64").toString("utf8");
    expect(written).toContain("provider: openai-compat");
    expect(written).toContain("baseURL: https://openrouter.ai/api/v1");
  });

  it("rejects requests without the shared-secret bearer", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/agents/my-agent/model", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("rejects when :slug doesn't match body.agentId", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/agents/other-agent/model", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("agent_id_mismatch");
  });

  it("rejects an invalid model spec", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/agents/my-agent/model", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ ...VALID_BODY, spec: { provider: "bogus", model: "" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_model_spec");
  });

  it("returns 404 when the agent id is not in the manifest", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/agents/ghost/model", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ ...VALID_BODY, agentId: "ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when GitHub rejects the write with a stale-sha conflict", async () => {
    const conflict = Object.assign(new Error("conflict"), { status: 409 });
    const createOrUpdate = vi.fn(async () => {
      throw conflict;
    });
    const { app } = makeApp({ createOrUpdate });
    const res = await app.request("/api/agents/my-agent/model", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("stale_sha");
  });

  it("returns 409 when the installation can't read the repo", async () => {
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const getContent = vi.fn(async () => {
      throw notFound;
    });
    const { app } = makeApp({ getContent });
    const res = await app.request("/api/agents/my-agent/model", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("repo_or_installation_not_found");
  });

  it("short-circuits when the spec already matches and skips the write", async () => {
    const { app, createOrUpdate } = makeApp();
    const res = await app.request("/api/agents/my-agent/model", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        ...VALID_BODY,
        spec: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; unchanged?: boolean };
    expect(body.ok).toBe(true);
    expect(body.unchanged).toBe(true);
    expect(createOrUpdate).not.toHaveBeenCalled();
  });
});
