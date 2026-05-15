import type { AgentDefinition } from "@render-harness/core";
import { describe, expect, it } from "vitest";
import { runCronFromRegistry } from "./index.js";

function fakeAgent(name: string): AgentDefinition {
  return {
    name,
    version: "test",
    systemPrompt: "x",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  } as AgentDefinition;
}

describe("runCronFromRegistry — agent lookup", () => {
  it("rejects an empty agentId with a list of known agents", async () => {
    const agents = { chat: fakeAgent("chat"), nightly: fakeAgent("nightly") };
    await expect(runCronFromRegistry({ agents, agentId: "" })).rejects.toThrow(
      /agentId is empty.*chat, nightly/,
    );
  });

  it("rejects an unknown agentId with a list of known agents", async () => {
    const agents = { chat: fakeAgent("chat") };
    await expect(runCronFromRegistry({ agents, agentId: "missing" })).rejects.toThrow(
      /agent "missing" not found.*chat/,
    );
  });

  it("rejects an empty registry with (none) hint", async () => {
    await expect(runCronFromRegistry({ agents: {}, agentId: "anything" })).rejects.toThrow(
      /Known: \(none\)/,
    );
  });
});
