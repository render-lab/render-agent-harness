import { HarnessConfigSchema } from "@render-harness/registry/schema";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  AgentNotEditableError,
  AgentNotFoundError,
  InvalidManifestError,
  mutateAgentModel,
  mutateAgentSystemPrompt,
} from "./yaml-edit.js";

const BASE_YAML = `schemaVersion: 1
name: my-agent
description: A test agent.
harnessVersion: ^0.1
license: MIT
shared:
  model:
    provider: anthropic
    model: claude-sonnet-4-6
  ui: true
agents:
  - id: my-agent
    # this agent handles incoming chat
    agent:
      kind: builtin
      ref: chat
      systemPrompt: hello
    model:
      provider: anthropic
      model: claude-sonnet-4-6
    runtimes:
      - kind: web
        plan: starter
`;

describe("mutateAgentModel", () => {
  it("replaces the matched agent's model block", () => {
    const next = mutateAgentModel({
      yamlText: BASE_YAML,
      agentId: "my-agent",
      spec: {
        provider: "openai-compat",
        model: "openai/gpt-4o",
        baseURL: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
    });
    const parsed = HarnessConfigSchema.parse(parseYaml(next));
    expect(parsed.agents[0]?.model).toEqual({
      provider: "openai-compat",
      model: "openai/gpt-4o",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    });
    // shared.model is untouched.
    expect(parsed.shared?.model).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("preserves comments and key order in unrelated sections", () => {
    const next = mutateAgentModel({
      yamlText: BASE_YAML,
      agentId: "my-agent",
      spec: { provider: "anthropic", model: "claude-opus-4-7" },
    });
    expect(next).toContain("# this agent handles incoming chat");
    // schemaVersion must remain the first top-level key.
    expect(next.split("\n")[0]).toMatch(/^schemaVersion:/);
  });

  it("removes optional fields when switching back to a simpler spec", () => {
    const withExtras = mutateAgentModel({
      yamlText: BASE_YAML,
      agentId: "my-agent",
      spec: {
        provider: "openai-compat",
        model: "openai/gpt-4o",
        baseURL: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
    });
    const next = mutateAgentModel({
      yamlText: withExtras,
      agentId: "my-agent",
      spec: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    expect(next).not.toContain("baseURL");
    expect(next).not.toContain("apiKeyEnv");
    expect(next).not.toContain("openrouter");
  });

  it("throws AgentNotFoundError when the agent id doesn't exist", () => {
    expect(() =>
      mutateAgentModel({
        yamlText: BASE_YAML,
        agentId: "ghost",
        spec: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    ).toThrow(AgentNotFoundError);
  });

  it("throws InvalidManifestError when agents[] is missing", () => {
    const noAgents = `schemaVersion: 1
name: x
description: y
harnessVersion: ^0.1
`;
    expect(() =>
      mutateAgentModel({
        yamlText: noAgents,
        agentId: "x",
        spec: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    ).toThrow(InvalidManifestError);
  });

  it("preserves thinking config when set", () => {
    const next = mutateAgentModel({
      yamlText: BASE_YAML,
      agentId: "my-agent",
      spec: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true, budgetTokens: 12_000 },
      },
    });
    const parsed = HarnessConfigSchema.parse(parseYaml(next));
    expect(parsed.agents[0]?.model?.thinking).toEqual({
      enabled: true,
      budgetTokens: 12_000,
    });
  });

  it("round-trip is idempotent", () => {
    const spec = {
      provider: "openai-compat" as const,
      model: "openai/gpt-4o",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    };
    const once = mutateAgentModel({ yamlText: BASE_YAML, agentId: "my-agent", spec });
    const twice = mutateAgentModel({ yamlText: once, agentId: "my-agent", spec });
    expect(twice).toBe(once);
  });
});

const MULTI_AGENT_YAML = `schemaVersion: 1
name: my-agent
description: A test agent.
harnessVersion: ^0.1
license: MIT
shared:
  model:
    provider: anthropic
    model: claude-sonnet-4-6
agents:
  - id: chat
    # builtin chat agent
    agent:
      kind: builtin
      ref: chat
      systemPrompt: hello
    runtimes:
      - kind: web
  - id: digest
    agent:
      kind: custom
      entrypoint: ./src/digest.ts
    runtimes:
      - kind: cron
        schedule: "0 9 * * *"
`;

describe("mutateAgentSystemPrompt", () => {
  it("replaces the matched agent's systemPrompt (inline scalar for single-line)", () => {
    const next = mutateAgentSystemPrompt({
      yamlText: MULTI_AGENT_YAML,
      agentId: "chat",
      systemPrompt: "you are a helpful assistant",
    });
    const parsed = HarnessConfigSchema.parse(parseYaml(next));
    const chatEntry = parsed.agents.find((a) => a.id === "chat");
    expect(chatEntry?.agent.kind).toBe("builtin");
    if (chatEntry?.agent.kind === "builtin") {
      expect(chatEntry.agent.systemPrompt).toBe("you are a helpful assistant");
    }
    // shared.model untouched.
    expect(parsed.shared?.model).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("emits a block-literal scalar for multi-line prompts", () => {
    const multi = "line one\nline two\n  indented continuation\nline four";
    const next = mutateAgentSystemPrompt({
      yamlText: MULTI_AGENT_YAML,
      agentId: "chat",
      systemPrompt: multi,
    });
    // The on-disk form should use a `|` block scalar; the parsed
    // value round-trips losslessly.
    expect(next).toMatch(/systemPrompt:\s*\|/);
    const parsed = HarnessConfigSchema.parse(parseYaml(next));
    const chatEntry = parsed.agents.find((a) => a.id === "chat");
    expect(chatEntry?.agent.kind).toBe("builtin");
    if (chatEntry?.agent.kind === "builtin") {
      expect(chatEntry.agent.systemPrompt).toBe(multi);
    }
  });

  it("preserves comments and other agents", () => {
    const next = mutateAgentSystemPrompt({
      yamlText: MULTI_AGENT_YAML,
      agentId: "chat",
      systemPrompt: "fresh prompt",
    });
    expect(next).toContain("# builtin chat agent");
    // The second (custom) agent stays intact.
    expect(next).toContain("entrypoint: ./src/digest.ts");
  });

  it("refuses to edit kind: custom agents", () => {
    let err: unknown;
    try {
      mutateAgentSystemPrompt({
        yamlText: MULTI_AGENT_YAML,
        agentId: "digest",
        systemPrompt: "anything",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentNotEditableError);
    expect((err as AgentNotEditableError).entrypoint).toBe("./src/digest.ts");
    expect((err as AgentNotEditableError).agentId).toBe("digest");
  });

  it("throws AgentNotFoundError when the agent id doesn't exist", () => {
    expect(() =>
      mutateAgentSystemPrompt({
        yamlText: MULTI_AGENT_YAML,
        agentId: "ghost",
        systemPrompt: "x",
      }),
    ).toThrow(AgentNotFoundError);
  });

  it("throws InvalidManifestError when agents[] is missing", () => {
    const noAgents = `schemaVersion: 1
name: x
description: y
harnessVersion: ^0.1
`;
    expect(() =>
      mutateAgentSystemPrompt({
        yamlText: noAgents,
        agentId: "x",
        systemPrompt: "x",
      }),
    ).toThrow(InvalidManifestError);
  });

  it("round-trip is idempotent for the same prompt", () => {
    const once = mutateAgentSystemPrompt({
      yamlText: MULTI_AGENT_YAML,
      agentId: "chat",
      systemPrompt: "settled prompt",
    });
    const twice = mutateAgentSystemPrompt({
      yamlText: once,
      agentId: "chat",
      systemPrompt: "settled prompt",
    });
    expect(twice).toBe(once);
  });
});
