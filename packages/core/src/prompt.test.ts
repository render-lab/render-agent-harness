import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "./prompt.js";
import type { AgentDefinition, SkillMetadata } from "./types.js";

const baseAgent: AgentDefinition = {
  name: "x",
  version: "0.1.0",
  model: { provider: "anthropic", model: "claude-sonnet-4-7" },
  systemPrompt: "You are a helpful agent.",
};

describe("assembleSystemPrompt", () => {
  it("includes the agent prompt and built-in tool guide when no skills", () => {
    const out = assembleSystemPrompt({ agent: baseAgent, skills: [] });
    expect(out).toContain("You are a helpful agent.");
    expect(out).toContain("Built-in tools");
    expect(out).toContain("load_skill");
    expect(out).toContain("fetch_full_result");
    expect(out).not.toContain("Available skills");
  });

  it("renders a skills index with names, descriptions, and when_to_use", () => {
    const skills: SkillMetadata[] = [
      {
        name: "deploy",
        description: "Deploys repos to Render",
        whenToUse: "When the user wants to ship",
        contentPath: "/x/SKILL.md",
      },
      {
        name: "audit",
        description: "Audits a service",
        whenToUse: "Audits a service",
        contentPath: "/y/SKILL.md",
      },
    ];
    const out = assembleSystemPrompt({ agent: baseAgent, skills });
    expect(out).toContain("Available skills");
    expect(out).toContain("**deploy** — Deploys repos to Render");
    expect(out).toContain("When to use: When the user wants to ship");
    // When whenToUse equals description, the "When to use" line is suppressed.
    const auditChunk = out.split("**audit**")[1] ?? "";
    expect(auditChunk).not.toContain("When to use:");
  });

  it("places the user's prompt first", () => {
    const out = assembleSystemPrompt({ agent: baseAgent, skills: [] });
    expect(out.indexOf("You are a helpful agent.")).toBeLessThan(out.indexOf("Built-in tools"));
  });
});
