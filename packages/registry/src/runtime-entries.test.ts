import type { HarnessConfig } from "@render-harness/registry";
import { describe, expect, it } from "vitest";
import { ensureTsupEntries, requiredEntries } from "./runtime-entries.js";

function cfg(input: Partial<HarnessConfig> & { agents: HarnessConfig["agents"] }): HarnessConfig {
  return {
    schemaVersion: 1,
    name: "test-bundle",
    description: "x",
    harnessVersion: "^0.1",
    shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
    ...input,
  } as HarnessConfig;
}

const builtinChat = { kind: "builtin", ref: "chat", systemPrompt: "hi" } as const;

describe("requiredEntries", () => {
  it("returns no multi-runtime entries for a single-agent web project (uses dist/main.js)", () => {
    const c = cfg({
      name: "chat-agent",
      agents: [
        {
          id: "chat-agent",
          agent: builtinChat,
          runtimes: [{ kind: "web" }],
        },
      ],
    });
    expect(requiredEntries(c)).toEqual([]);
  });

  it("returns no multi-runtime entries for a single-agent cron project (uses dist/main.js)", () => {
    const c = cfg({
      name: "research-cron",
      agents: [
        {
          id: "research-cron",
          agent: builtinChat,
          runtimes: [{ kind: "cron", schedule: "0 13 * * *" }],
        },
      ],
    });
    expect(requiredEntries(c)).toEqual([]);
  });

  it("requires web + worker entries for a single-agent web+worker bundle (web shell pattern)", () => {
    const c = cfg({
      name: "support-bot",
      agents: [
        {
          id: "support-bot",
          agent: builtinChat,
          runtimes: [{ kind: "web" }, { kind: "worker", queue: "support-bot-runs" }],
        },
      ],
    });
    const names = requiredEntries(c).map((e) => e.name);
    expect(names).toContain("web");
    expect(names).toContain("worker");
    expect(names).not.toContain("cron");
  });

  it("requires a cron entry when a second cron lands in a single-cron project", () => {
    const c = cfg({
      name: "research-cron",
      agents: [
        {
          id: "research-cron",
          agent: builtinChat,
          runtimes: [{ kind: "cron", schedule: "0 13 * * *" }],
        },
        {
          id: "another-cron",
          agent: builtinChat,
          runtimes: [{ kind: "cron", schedule: "0 15 * * *" }],
        },
      ],
    });
    const names = requiredEntries(c).map((e) => e.name);
    expect(names).toEqual(["cron"]);
  });

  it("requires cron alongside web+worker when adding research-cron to a support-bot project", () => {
    const c = cfg({
      name: "support-bot",
      agents: [
        {
          id: "support-bot",
          agent: builtinChat,
          runtimes: [{ kind: "web" }, { kind: "worker", queue: "support-bot-runs" }],
        },
        {
          id: "research-cron",
          agent: builtinChat,
          runtimes: [{ kind: "cron", schedule: "0 13 * * *" }],
        },
      ],
    });
    const names = requiredEntries(c)
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(["cron", "web", "worker"]);
  });

  it("requires a cron entry when adding research-cron to a single-agent web project (sync web stays main)", () => {
    const c = cfg({
      name: "chat-agent",
      agents: [
        {
          id: "chat-agent",
          agent: builtinChat,
          runtimes: [{ kind: "web" }],
        },
        {
          id: "research-cron",
          agent: builtinChat,
          runtimes: [{ kind: "cron", schedule: "0 13 * * *" }],
        },
      ],
    });
    const names = requiredEntries(c).map((e) => e.name);
    expect(names).toEqual(["cron"]);
  });

  it("requires cron-trigger for via:workflow crons and a workflows entry when any agent is a workflow task", () => {
    const c = cfg({
      name: "delegator",
      agents: [
        {
          id: "trigger-only",
          agent: builtinChat,
          runtimes: [{ kind: "cron", schedule: "0 0 * * *", via: "workflow" }],
        },
        {
          id: "wf-task",
          agent: builtinChat,
          runtimes: [{ kind: "workflows" }],
        },
      ],
    });
    const names = requiredEntries(c)
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(["cron-trigger", "workflows"]);
  });
});

describe("ensureTsupEntries", () => {
  const multiLine = `import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    web: "src/web.ts",
    worker: "src/worker.ts",
  },
  format: ["esm"],
  clean: true,
  target: "node22",
});
`;

  const singleLine = `import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
});
`;

  it("is a no-op when every required entry already exists", () => {
    const result = ensureTsupEntries(multiLine, ["web", "worker"]);
    expect(result.changed).toBe(false);
    expect(result.patched).toBe(true);
    expect(result.text).toBe(multiLine);
  });

  it("appends a missing cron entry to a multi-line entry block, preserving existing ones", () => {
    const result = ensureTsupEntries(multiLine, ["web", "worker", "cron"]);
    expect(result.changed).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.text).toContain('web: "src/web.ts"');
    expect(result.text).toContain('worker: "src/worker.ts"');
    expect(result.text).toContain('"cron": "src/cron.ts"');
    // Existing entries should not have been rewritten / requoted.
    expect(result.text).toMatch(/web: "src\/web\.ts",/);
  });

  it("expands a single-line { main } entry into a list when a cron is needed", () => {
    const result = ensureTsupEntries(singleLine, ["cron"]);
    expect(result.changed).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.text).toContain('main: "src/main.ts"');
    expect(result.text).toContain('"cron": "src/cron.ts"');
  });

  it("flags `patched: false` when the entry block can't be found", () => {
    const odd = `export default { unrelated: true };\n`;
    const result = ensureTsupEntries(odd, ["cron"]);
    expect(result.patched).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(odd);
  });

  it("returns the original text when required is empty", () => {
    const result = ensureTsupEntries(multiLine, []);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(multiLine);
  });
});
