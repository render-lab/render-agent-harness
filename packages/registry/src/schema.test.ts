import { describe, expect, it } from "vitest";
import {
  HarnessConfigSchema,
  IndexSchema,
  flattenRuntimeKinds,
  isWorkflowTaskAgent,
  parseHarnessConfigYaml,
  workflowTaskAgents,
} from "./schema.js";

describe("HarnessConfigSchema", () => {
  const baseAgent = {
    id: "chat",
    agent: { kind: "builtin", ref: "chat", systemPrompt: "Hello." } as const,
    runtimes: [{ kind: "web" } as const],
  };

  it("accepts a minimal bundle with shared model", () => {
    const cfg = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "demo",
      description: "A minimal bundle.",
      harnessVersion: "^0.1",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      agents: [baseAgent],
    });
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents[0]?.id).toBe("chat");
  });

  it("accepts a multi-agent bundle with mixed runtimes", () => {
    const cfg = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "chief-of-staff",
      description: "...",
      harnessVersion: "^0.1",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      agents: [
        {
          id: "chat",
          agent: { kind: "custom", entrypoint: "./src/chat.ts" },
          runtimes: [{ kind: "web" }, { kind: "worker" }],
        },
        {
          id: "meeting-prep",
          agent: { kind: "custom", entrypoint: "./src/meeting-prep.ts" },
          runtimes: [{ kind: "cron", schedule: "*/15 * * * *" }],
        },
        {
          id: "weekly-recap",
          agent: { kind: "custom", entrypoint: "./src/weekly-recap.ts" },
          runtimes: [{ kind: "cron", schedule: "0 17 * * 5" }],
        },
      ],
    });
    expect(cfg.agents.map((a) => a.id)).toEqual(["chat", "meeting-prep", "weekly-recap"]);
  });

  it("rejects duplicate agent ids", () => {
    expect(() =>
      HarnessConfigSchema.parse({
        schemaVersion: 1,
        name: "demo",
        description: "x",
        harnessVersion: "^0.1",
        shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
        agents: [baseAgent, { ...baseAgent, runtimes: [{ kind: "cron", schedule: "0 0 * * *" }] }],
      }),
    ).toThrow(/duplicate agent id/);
  });

  it("rejects per-agent duplicate runtime kinds", () => {
    expect(() =>
      HarnessConfigSchema.parse({
        schemaVersion: 1,
        name: "demo",
        description: "x",
        harnessVersion: "^0.1",
        shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
        agents: [{ ...baseAgent, runtimes: [{ kind: "web" }, { kind: "web" }] }],
      }),
    ).toThrow(/duplicate runtime kind/);
  });

  it("allows the same runtime kind across different agents", () => {
    const cfg = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "demo",
      description: "x",
      harnessVersion: "^0.1",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      agents: [
        { ...baseAgent, id: "a", runtimes: [{ kind: "cron", schedule: "0 13 * * *" }] },
        { ...baseAgent, id: "b", runtimes: [{ kind: "cron", schedule: "0 17 * * 5" }] },
      ],
    });
    expect(cfg.agents).toHaveLength(2);
  });

  it("rejects an agent with no model and no shared.model", () => {
    expect(() =>
      HarnessConfigSchema.parse({
        schemaVersion: 1,
        name: "demo",
        description: "x",
        harnessVersion: "^0.1",
        agents: [baseAgent],
      }),
    ).toThrow(/no model and shared\.model is not set/);
  });

  it("accepts a per-agent model override", () => {
    const cfg = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "demo",
      description: "x",
      harnessVersion: "^0.1",
      agents: [
        {
          ...baseAgent,
          model: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        },
      ],
    });
    expect(cfg.agents[0]?.model?.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("parseHarnessConfigYaml", () => {
  it("parses a single-agent YAML manifest", () => {
    const cfg = parseHarnessConfigYaml(`
schemaVersion: 1
name: legacy
description: Legacy entry.
harnessVersion: "^0.1"
shared:
  model:
    provider: anthropic
    model: claude-sonnet-4-6
agents:
  - id: legacy
    agent: { kind: builtin, ref: chat, systemPrompt: x }
    runtimes:
      - kind: cron
        schedule: "0 13 * * *"
`);
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents[0]?.runtimes[0]).toMatchObject({ kind: "cron", schedule: "0 13 * * *" });
  });

  it("parses a multi-agent bundle YAML manifest", () => {
    const cfg = parseHarnessConfigYaml(`
schemaVersion: 1
name: bundle
description: Bundle entry.
harnessVersion: "^0.1"
shared:
  model:
    provider: anthropic
    model: claude-sonnet-4-6
agents:
  - id: chat
    agent: { kind: builtin, ref: chat, systemPrompt: x }
    runtimes: [{ kind: web }]
  - id: nightly
    agent: { kind: builtin, ref: chat, systemPrompt: y }
    runtimes: [{ kind: cron, schedule: "0 2 * * *" }]
`);
    expect(cfg.agents).toHaveLength(2);
  });
});

describe("workflow-task helpers", () => {
  function buildBundle(...agents: Array<Record<string, unknown>>) {
    return HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "demo",
      description: "x",
      harnessVersion: "^0.1",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      agents,
    });
  }

  it("treats explicit workflowTask: true as a workflow-task agent", () => {
    const cfg = buildBundle({
      id: "a",
      workflowTask: true,
      agent: { kind: "custom", entrypoint: "./src/a.ts" },
      runtimes: [{ kind: "web" }],
    });
    expect(isWorkflowTaskAgent(cfg.agents[0]!)).toBe(true);
    expect(workflowTaskAgents(cfg).map((a) => a.id)).toEqual(["a"]);
  });

  it("treats kind: workflows runtime as a workflow-task agent", () => {
    const cfg = buildBundle({
      id: "a",
      agent: { kind: "custom", entrypoint: "./src/a.ts" },
      runtimes: [{ kind: "workflows" }],
    });
    expect(isWorkflowTaskAgent(cfg.agents[0]!)).toBe(true);
  });

  it("treats kind: cron, via: workflow as a workflow-task agent", () => {
    const cfg = buildBundle({
      id: "a",
      agent: { kind: "custom", entrypoint: "./src/a.ts" },
      runtimes: [{ kind: "cron", schedule: "0 0 * * *", via: "workflow" }],
    });
    expect(isWorkflowTaskAgent(cfg.agents[0]!)).toBe(true);
  });

  it("does NOT treat a default-via cron agent as workflow-task", () => {
    const cfg = buildBundle({
      id: "a",
      agent: { kind: "custom", entrypoint: "./src/a.ts" },
      runtimes: [{ kind: "cron", schedule: "0 0 * * *" }],
    });
    expect(isWorkflowTaskAgent(cfg.agents[0]!)).toBe(false);
    expect(workflowTaskAgents(cfg)).toEqual([]);
  });

  it("accepts via: cron explicitly (same as default)", () => {
    const cfg = buildBundle({
      id: "a",
      agent: { kind: "custom", entrypoint: "./src/a.ts" },
      runtimes: [{ kind: "cron", schedule: "0 0 * * *", via: "cron" }],
    });
    expect(isWorkflowTaskAgent(cfg.agents[0]!)).toBe(false);
  });

  it("returns workflow-task agents in declaration order", () => {
    const cfg = buildBundle(
      {
        id: "chat",
        agent: { kind: "custom", entrypoint: "./src/chat.ts" },
        runtimes: [{ kind: "web" }],
      },
      {
        id: "weekly",
        workflowTask: true,
        agent: { kind: "custom", entrypoint: "./src/weekly.ts" },
        runtimes: [{ kind: "cron", schedule: "0 17 * * 5", via: "workflow" }],
      },
      {
        id: "ondemand",
        workflowTask: true,
        agent: { kind: "custom", entrypoint: "./src/ondemand.ts" },
        runtimes: [{ kind: "workflows" }],
      },
    );
    expect(workflowTaskAgents(cfg).map((a) => a.id)).toEqual(["weekly", "ondemand"]);
  });
});

describe("flattenRuntimeKinds", () => {
  it("returns the union of all agents' runtime kinds", () => {
    const cfg = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "demo",
      description: "x",
      harnessVersion: "^0.1",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      agents: [
        {
          id: "a",
          agent: { kind: "builtin", ref: "chat", systemPrompt: "x" },
          runtimes: [{ kind: "web" }, { kind: "worker" }],
        },
        {
          id: "b",
          agent: { kind: "builtin", ref: "chat", systemPrompt: "x" },
          runtimes: [{ kind: "cron", schedule: "0 0 * * *" }],
        },
        {
          id: "c",
          agent: { kind: "builtin", ref: "chat", systemPrompt: "x" },
          runtimes: [{ kind: "cron", schedule: "0 12 * * *" }],
        },
      ],
    });
    expect(flattenRuntimeKinds(cfg).sort()).toEqual(["cron", "web", "worker"]);
  });
});

describe("IndexSchema", () => {
  it("rejects non-SHA refs", () => {
    expect(() =>
      IndexSchema.parse({
        schemaVersion: 1,
        entries: [
          {
            name: "demo",
            description: "x",
            repo: "https://github.com/foo/bar",
            ref: "v0.1.0",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate entry names", () => {
    expect(() =>
      IndexSchema.parse({
        schemaVersion: 1,
        entries: [
          {
            name: "demo",
            description: "x",
            repo: "https://github.com/foo/bar",
            ref: "0".repeat(40),
          },
          {
            name: "demo",
            description: "y",
            repo: "https://github.com/foo/baz",
            ref: "1".repeat(40),
          },
        ],
      }),
    ).toThrow(/duplicate entry name/);
  });

  it("accepts a valid entry", () => {
    const idx = IndexSchema.parse({
      schemaVersion: 1,
      entries: [
        {
          name: "demo",
          description: "x",
          repo: "https://github.com/foo/bar",
          ref: "9b2a7c1c3f4e8d6b1a2f3c4d5e6f7a8b9c0d1e2f",
        },
      ],
    });
    expect(idx.entries).toHaveLength(1);
  });
});
