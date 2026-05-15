import { describe, expect, it } from "vitest";
import { buildBuiltinTools } from "./index.js";
import type { BuiltinContext } from "./types.js";

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => fakeLogger,
} as unknown as BuiltinContext["logger"];

function makeCtx(env: Record<string, string | undefined> = {}): BuiltinContext {
  return {
    pool: {} as BuiltinContext["pool"],
    skills: [],
    runId: "run_test",
    userId: "user_test",
    agentName: "test-agent",
    logger: fakeLogger,
    env: env as NodeJS.ProcessEnv,
  };
}

describe("buildBuiltinTools registry", () => {
  it("registers Tier A always-on tools regardless of env", () => {
    const { tools } = buildBuiltinTools(makeCtx());
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain("load_skill");
    expect(names).toContain("fetch_full_result");
    expect(names).toContain("fetch_url");
    expect(names).toContain("current_time");
    expect(names).toContain("ask_user");
    expect(names).toContain("todo");
    expect(names).toContain("list_my_runs");
  });

  it("skips Tier B providers when no env is set", () => {
    const { tools, skipped } = buildBuiltinTools(makeCtx());
    const names = tools.map((t) => t.definition.name);
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_extract");
    expect(names).not.toContain("image_generate");
    expect(names).not.toContain("trigger_workflow");
    const skippedNames = skipped.map((s) => s.name);
    expect(skippedNames).toContain("web_search");
    expect(skippedNames).toContain("web_extract");
    expect(skippedNames).toContain("image_generate");
    expect(skippedNames).toContain("trigger_workflow");
  });

  it("registers web_search via Exa when EXA_API_KEY is set", () => {
    const { tools } = buildBuiltinTools(makeCtx({ EXA_API_KEY: "k" }));
    const ws = tools.find((t) => t.definition.name === "web_search");
    expect(ws).toBeDefined();
    expect(ws?.definition.description).toMatch(/exa/i);
  });

  it("prefers Exa over Tavily over Brave by default", () => {
    const ctx = makeCtx({ EXA_API_KEY: "e", TAVILY_API_KEY: "t", BRAVE_API_KEY: "b" });
    const { tools } = buildBuiltinTools(ctx);
    const ws = tools.find((t) => t.definition.name === "web_search");
    expect(ws?.definition.description).toMatch(/exa/i);
  });

  it("HARNESS_WEB_SEARCH_PROVIDER overrides the default chain", () => {
    const ctx = makeCtx({
      EXA_API_KEY: "e",
      TAVILY_API_KEY: "t",
      HARNESS_WEB_SEARCH_PROVIDER: "tavily",
    });
    const { tools } = buildBuiltinTools(ctx);
    const ws = tools.find((t) => t.definition.name === "web_search");
    expect(ws?.definition.description).toMatch(/tavily/i);
  });

  it("registers web_extract with Firecrawl when FIRECRAWL_API_KEY is set", () => {
    const { tools } = buildBuiltinTools(makeCtx({ FIRECRAWL_API_KEY: "k" }));
    const we = tools.find((t) => t.definition.name === "web_extract");
    expect(we?.definition.description).toMatch(/firecrawl/i);
  });

  it("registers image_generate with OpenAI when OPENAI_API_KEY is set", () => {
    const { tools } = buildBuiltinTools(makeCtx({ OPENAI_API_KEY: "k" }));
    const ig = tools.find((t) => t.definition.name === "image_generate");
    expect(ig?.definition.description).toMatch(/openai/i);
  });

  it("registers trigger_workflow when RENDER_API_KEY and WORKFLOW_SLUG are both set", () => {
    const { tools } = buildBuiltinTools(
      makeCtx({ RENDER_API_KEY: "rnd_x", WORKFLOW_SLUG: "demo-workflows" }),
    );
    const tw = tools.find((t) => t.definition.name === "trigger_workflow");
    expect(tw).toBeDefined();
    expect(tw?.definition.description).toContain("demo-workflows");
  });

  it("skips trigger_workflow with a clear reason when only RENDER_API_KEY is set", () => {
    const { skipped } = buildBuiltinTools(makeCtx({ RENDER_API_KEY: "rnd_x" }));
    const entry = skipped.find((s) => s.name === "trigger_workflow");
    expect(entry?.reason).toMatch(/WORKFLOW_SLUG/);
  });

  it("skips trigger_workflow with a clear reason when only WORKFLOW_SLUG is set", () => {
    const { skipped } = buildBuiltinTools(makeCtx({ WORKFLOW_SLUG: "demo-workflows" }));
    const entry = skipped.find((s) => s.name === "trigger_workflow");
    expect(entry?.reason).toMatch(/RENDER_API_KEY/);
  });
});
