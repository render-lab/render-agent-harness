import type { Octokit } from "@octokit/rest";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAgentSystemPromptRoute } from "./agent-system-prompt.js";

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
      systemPrompt: original
    model:
      provider: anthropic
      model: claude-sonnet-4-6
    runtimes:
      - kind: web
        plan: starter
  - id: digest-cron
    agent:
      kind: custom
      entrypoint: ./src/digest.ts
    runtimes:
      - kind: cron
        schedule: "0 9 * * *"
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

  registerAgentSystemPromptRoute(app, {
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
  systemPrompt: "you are an updated assistant",
};

describe("PATCH /api/agents/:slug/system-prompt", () => {
  it("commits an updated manifest to main", async () => {
    const { app, getContent, createOrUpdate } = makeApp();
    const res = await app.request("/api/agents/my-agent/system-prompt", {
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
    expect(writeCall.message).toMatch(/my-agent.*system prompt/);
    const written = Buffer.from(writeCall.content, "base64").toString("utf8");
    expect(written).toContain("you are an updated assistant");
    expect(written).not.toContain("systemPrompt: original");
  });

  it("emits a block scalar for multi-line prompts", async () => {
    const { app, createOrUpdate } = makeApp();
    const prompt = "first line\nsecond line\nthird line";
    const res = await app.request("/api/agents/my-agent/system-prompt", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ ...VALID_BODY, systemPrompt: prompt }),
    });
    expect(res.status).toBe(200);
    const writeCall = createOrUpdate.mock.calls[0]?.[0] as { content: string };
    const written = Buffer.from(writeCall.content, "base64").toString("utf8");
    expect(written).toMatch(/systemPrompt:\s*\|/);
    expect(written).toContain("first line");
    expect(written).toContain("third line");
  });

  it("rejects requests without the shared-secret bearer", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/agents/my-agent/system-prompt", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("rejects when :slug doesn't match body.agentId", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/agents/other-agent/system-prompt", {
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

  it("rejects an empty system prompt", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/agents/my-agent/system-prompt", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ ...VALID_BODY, systemPrompt: "   \n  " }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_system_prompt");
  });

  it("rejects a non-string systemPrompt", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/agents/my-agent/system-prompt", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ ...VALID_BODY, systemPrompt: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the agent id is not in the manifest", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/agents/ghost/system-prompt", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ ...VALID_BODY, agentId: "ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 with entrypoint hint when the agent is kind: custom", async () => {
    const { app, createOrUpdate } = makeApp();
    const res = await app.request("/api/agents/digest-cron/system-prompt", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ ...VALID_BODY, agentId: "digest-cron" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; entrypoint?: string };
    expect(body.error).toBe("agent_not_editable");
    expect(body.entrypoint).toBe("./src/digest.ts");
    expect(createOrUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 when GitHub rejects the write with a stale-sha conflict", async () => {
    const conflict = Object.assign(new Error("conflict"), { status: 409 });
    const createOrUpdate = vi.fn(async () => {
      throw conflict;
    });
    const { app } = makeApp({ createOrUpdate });
    const res = await app.request("/api/agents/my-agent/system-prompt", {
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

  it("short-circuits when the prompt is unchanged", async () => {
    const { app, createOrUpdate } = makeApp();
    const res = await app.request("/api/agents/my-agent/system-prompt", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ ...VALID_BODY, systemPrompt: "original" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; unchanged?: boolean };
    expect(body.ok).toBe(true);
    expect(body.unchanged).toBe(true);
    expect(createOrUpdate).not.toHaveBeenCalled();
  });
});
