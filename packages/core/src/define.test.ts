import { describe, expect, it } from "vitest";
import { defineAgent } from "./define.js";
import type { AgentDefinition } from "./types.js";

const base: AgentDefinition = {
  name: "valid-agent",
  version: "0.1.0",
  model: { provider: "anthropic", model: "claude-sonnet-4-7" },
  systemPrompt: "You are a test agent.",
};

describe("defineAgent", () => {
  it("returns the definition unchanged when valid", () => {
    expect(defineAgent(base)).toEqual(base);
  });

  it("rejects invalid names", () => {
    expect(() => defineAgent({ ...base, name: "Bad Name!" })).toThrow(/must match/);
    expect(() => defineAgent({ ...base, name: "" })).toThrow();
  });

  it("requires a non-empty system prompt", () => {
    expect(() => defineAgent({ ...base, systemPrompt: "   " })).toThrow(/systemPrompt/);
  });

  it("requires a model", () => {
    expect(() =>
      defineAgent({
        ...base,
        model: { provider: "anthropic" } as unknown as AgentDefinition["model"],
      }),
    ).toThrow(/model/);
  });

  it("rejects tools that are both denied and require approval", () => {
    expect(() =>
      defineAgent({
        ...base,
        permissions: {
          requireApproval: ["danger_tool"],
          deniedTools: ["danger_tool"],
        },
      }),
    ).toThrow(/both/);
  });
});
