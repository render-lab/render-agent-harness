import { HarnessConfigSchema } from "@render-harness/registry/schema";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { AgentNotFoundError, InvalidManifestError, mutateAgentModel } from "./yaml-edit.js";

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
