import type { HarnessConfig, ResolvedAgentEntry, ResolvedGallery } from "@render-harness/registry";
import { describe, expect, it } from "vitest";
import {
  AgentAddError,
  type AgentAddPlan,
  listAddableAgents,
  mutateEnvExampleForAgent,
  mutateManifestForAgentAdd,
  mutatePackageJsonAddDeps,
  mutatePackageJsonAddRuntimeDeps,
  planAgentAdd,
} from "./agent-add.js";

const BUNDLE_MANIFEST: HarnessConfig = {
  schemaVersion: 1,
  name: "chief-of-staff",
  description: "Personal chief of staff bundle.",
  harnessVersion: "^0.1",
  shared: {
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  },
  capabilities: [{ pack: "@render-harness/cap-memory-pg" }],
  envSchema: [
    { name: "CALENDAR_ICS_URL", required: false, secret: true, description: "Calendar URL." },
  ],
  agents: [
    {
      id: "chat",
      description: "Chat agent.",
      agent: { kind: "custom", entrypoint: "./src/chat.ts" },
      runtimes: [{ kind: "web" }, { kind: "worker" }],
    },
    {
      id: "meeting-prep",
      description: "Meeting prep cron.",
      agent: { kind: "custom", entrypoint: "./src/meeting-prep.ts" },
      runtimes: [{ kind: "cron", schedule: "*/15 * * * *" }],
    },
  ],
} as unknown as HarnessConfig;

const BUNDLE_ENTRY: ResolvedAgentEntry = {
  slug: "chief-of-staff",
  name: "Chief of Staff",
  description: "Bundle",
  surface: ["web-chat", "calendar"],
  audience: ["personal", "hiring"],
  runtimeKinds: ["web", "worker", "cron"],
  requiresHarness: "^0.1",
  capabilities: ["@render-harness/cap-memory-pg"],
  author: "render-harness",
  kind: "bundle",
  manifest: BUNDLE_MANIFEST,
  readme: null,
  sourceFiles: {
    "src/chat.ts": "// chat source\n",
    "src/meeting-prep.ts": "// meeting-prep source\n",
  },
};

const SINGLE_AGENT_MANIFEST: HarnessConfig = {
  schemaVersion: 1,
  name: "chat",
  description: "A minimal single-turn HTTP chat agent.",
  harnessVersion: "^0.2",
  shared: {
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  },
  agents: [
    {
      id: "chat-agent",
      agent: {
        kind: "builtin",
        ref: "chat",
        systemPrompt: "You are a helpful assistant.",
      },
      runtimes: [{ kind: "web" }],
    },
  ],
} as unknown as HarnessConfig;

const SINGLE_AGENT_ENTRY: ResolvedAgentEntry = {
  slug: "chat",
  name: "Chat",
  description: "A minimal single-turn HTTP chat agent.",
  surface: ["web-chat"],
  audience: [],
  runtimeKinds: ["web"],
  requiresHarness: "^0.2",
  capabilities: [],
  author: "render-harness",
  kind: "agent",
  manifest: SINGLE_AGENT_MANIFEST,
  readme: null,
  // Single-agent gallery entries don't ship a src/ tree — the agent
  // references a builtin (chat) shipped by @render-harness/registry.
  sourceFiles: {},
};

const GALLERY: ResolvedGallery = {
  schemaVersion: 1,
  agents: [BUNDLE_ENTRY, SINGLE_AGENT_ENTRY],
  capabilities: [
    {
      pack: "@render-harness/cap-memory-pg",
      description: "Long-term memory.",
      label: "Memory (pg)",
      envHint: null,
      versionRange: "^0.1.0",
    },
  ],
};

const TARGET_YAML = `schemaVersion: 1
name: my-harness
description: existing
harnessVersion: "^0.1"
shared:
  model: { provider: anthropic, model: claude-sonnet-4-6 }
agents:
  - id: original-chat
    agent: { kind: builtin, ref: chat, systemPrompt: hi }
    runtimes:
      - kind: web
      - kind: worker
        queue: my-runs
`;

describe("listAddableAgents", () => {
  it("flattens bundle agents into per-agent units", () => {
    const units = listAddableAgents(GALLERY);
    expect(units.map((u) => u.agentId).sort()).toEqual(["chat", "chat-agent", "meeting-prep"]);
    const meeting = units.find((u) => u.agentId === "meeting-prep");
    expect(meeting).toMatchObject({
      bundleSlug: "chief-of-staff",
      bundleName: "Chief of Staff",
      capabilities: ["@render-harness/cap-memory-pg"],
      envVars: ["CALENDAR_ICS_URL"],
    });
  });

  it("includes single-agent gallery entries with the entry description as fallback", () => {
    const units = listAddableAgents(GALLERY);
    const chat = units.find((u) => u.agentId === "chat-agent");
    expect(chat).toMatchObject({
      bundleSlug: "chat",
      bundleName: "Chat",
      agentId: "chat-agent",
      description: "A minimal single-turn HTTP chat agent.",
      runtimeKinds: ["web"],
      capabilities: [],
    });
  });
});

describe("planAgentAdd", () => {
  it("resolves source file + capability metadata", () => {
    const plan = planAgentAdd({
      gallery: GALLERY,
      source: { bundleSlug: "chief-of-staff", agentId: "meeting-prep" },
      manifestText: TARGET_YAML,
      existingSourceFileText: null,
    });
    expect(plan.spec.sourceFilePath).toBe("src/meeting-prep.ts");
    expect(plan.spec.sourceFileContent).toContain("meeting-prep source");
    expect(plan.spec.capabilities).toEqual([
      {
        // cap-memory-pg now ships in OFFICIAL_CAPABILITY_INSTALLS so the
        // planner picks up the wizard's authoritative version range
        // (^0.5.0) rather than falling back to the gallery snapshot's
        // older range.
        pack: "@render-harness/cap-memory-pg",
        versionRange: "^0.5.0",
        envVars: [],
      },
    ]);
    expect(plan.spec.envSchemaAdditions).toEqual([
      {
        name: "CALENDAR_ICS_URL",
        required: false,
        secret: true,
        description: "Calendar URL.",
      },
    ]);
  });

  it("rejects when bundle is missing", () => {
    expect(() =>
      planAgentAdd({
        gallery: GALLERY,
        source: { bundleSlug: "nope", agentId: "chat" },
        manifestText: TARGET_YAML,
        existingSourceFileText: null,
      }),
    ).toThrow(AgentAddError);
  });

  it("rejects when target manifest already has the agent id", () => {
    const yamlWithDup = TARGET_YAML.replace("id: original-chat", "id: meeting-prep");
    let caught: unknown;
    try {
      planAgentAdd({
        gallery: GALLERY,
        source: { bundleSlug: "chief-of-staff", agentId: "meeting-prep" },
        manifestText: yamlWithDup,
        existingSourceFileText: null,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentAddError);
    expect((caught as AgentAddError).code).toBe("agent_id_exists");
  });

  it("rejects when src/<id>.ts exists with different content", () => {
    let caught: unknown;
    try {
      planAgentAdd({
        gallery: GALLERY,
        source: { bundleSlug: "chief-of-staff", agentId: "meeting-prep" },
        manifestText: TARGET_YAML,
        existingSourceFileText: "// some other content\n",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentAddError);
    expect((caught as AgentAddError).code).toBe("source_file_conflict");
  });

  it("warns (but does not throw) when src file is byte-identical", () => {
    const plan = planAgentAdd({
      gallery: GALLERY,
      source: { bundleSlug: "chief-of-staff", agentId: "meeting-prep" },
      manifestText: TARGET_YAML,
      existingSourceFileText: "// meeting-prep source\n",
    });
    expect(plan.warnings.some((w) => w.includes("identical content"))).toBe(true);
  });

  it("plans a builtin-agent add with no source file to write", () => {
    const plan = planAgentAdd({
      gallery: GALLERY,
      source: { bundleSlug: "chat", agentId: "chat-agent" },
      manifestText: TARGET_YAML,
      existingSourceFileText: null,
    });
    expect(plan.spec.sourceFilePath).toBeNull();
    expect(plan.spec.sourceFileContent).toBeNull();
    expect(plan.warnings).toEqual([]);
    expect(plan.spec.agentEntry).toMatchObject({
      id: "chat-agent",
      agent: { kind: "builtin", ref: "chat" },
    });
  });
});

describe("mutateManifestForAgentAdd", () => {
  it("appends to agents[], merges capabilities and envSchema", () => {
    const plan = planAgentAdd({
      gallery: GALLERY,
      source: { bundleSlug: "chief-of-staff", agentId: "meeting-prep" },
      manifestText: TARGET_YAML,
      existingSourceFileText: null,
    });
    const next = mutateManifestForAgentAdd({ yamlText: TARGET_YAML, plan });
    expect(next).toContain("id: meeting-prep");
    expect(next).toContain("@render-harness/cap-memory-pg");
    expect(next).toContain("CALENDAR_ICS_URL");
    // Original agent untouched.
    expect(next).toContain("id: original-chat");
  });

  it("appends a builtin-agent entry without touching capabilities or envSchema", () => {
    const plan = planAgentAdd({
      gallery: GALLERY,
      source: { bundleSlug: "chat", agentId: "chat-agent" },
      manifestText: TARGET_YAML,
      existingSourceFileText: null,
    });
    const next = mutateManifestForAgentAdd({ yamlText: TARGET_YAML, plan });
    expect(next).toContain("id: chat-agent");
    expect(next).toContain("id: original-chat");
    expect(next).not.toContain("cap-memory-pg");
    expect(next).not.toContain("CALENDAR_ICS_URL");
  });

  it("does not duplicate capabilities already present", () => {
    const yamlWithCap = `${TARGET_YAML}capabilities:\n  - pack: "@render-harness/cap-memory-pg"\n`;
    const plan = planAgentAdd({
      gallery: GALLERY,
      source: { bundleSlug: "chief-of-staff", agentId: "meeting-prep" },
      manifestText: yamlWithCap,
      existingSourceFileText: null,
    });
    const next = mutateManifestForAgentAdd({ yamlText: yamlWithCap, plan });
    const matches = next.match(/cap-memory-pg/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("mutatePackageJsonAddDeps", () => {
  it("adds new capability deps with the resolved version", () => {
    const next = mutatePackageJsonAddDeps({
      jsonText: JSON.stringify({ dependencies: { existing: "1.0.0" } }, null, 2),
      capabilities: [
        { pack: "@render-harness/cap-memory-pg", versionRange: "^0.1.0", envVars: [] },
      ],
    });
    const parsed = JSON.parse(next) as { dependencies: Record<string, string> };
    expect(parsed.dependencies["@render-harness/cap-memory-pg"]).toBe("^0.1.0");
    expect(parsed.dependencies.existing).toBe("1.0.0");
  });

  it("skips deps already present", () => {
    const input = JSON.stringify(
      {
        dependencies: { "@render-harness/cap-memory-pg": "^0.0.9" },
      },
      null,
      2,
    );
    const next = mutatePackageJsonAddDeps({
      jsonText: input,
      capabilities: [
        { pack: "@render-harness/cap-memory-pg", versionRange: "^0.1.0", envVars: [] },
      ],
    });
    expect(next).toBe(input);
  });

  it("falls back to * when version range is null", () => {
    const next = mutatePackageJsonAddDeps({
      jsonText: JSON.stringify({ dependencies: {} }, null, 2),
      capabilities: [{ pack: "fictional-pack", versionRange: null, envVars: [] }],
    });
    const parsed = JSON.parse(next) as { dependencies: Record<string, string> };
    expect(parsed.dependencies["fictional-pack"]).toBe("*");
  });
});

describe("mutatePackageJsonAddRuntimeDeps", () => {
  it("inherits the version range from an existing @render-harness/* dep", () => {
    const input = JSON.stringify(
      {
        dependencies: {
          "@render-harness/core": "^0.5",
          "@render-harness/registry": "^0.5",
        },
      },
      null,
      2,
    );
    const next = mutatePackageJsonAddRuntimeDeps({
      jsonText: input,
      packages: ["@render-harness/runtime-cron"],
    });
    const parsed = JSON.parse(next) as { dependencies: Record<string, string> };
    expect(parsed.dependencies["@render-harness/runtime-cron"]).toBe("^0.5");
  });

  it("is a no-op when every package is already a dep", () => {
    const input = JSON.stringify(
      {
        dependencies: {
          "@render-harness/core": "^0.5",
          "@render-harness/runtime-cron": "^0.4.2",
        },
      },
      null,
      2,
    );
    const next = mutatePackageJsonAddRuntimeDeps({
      jsonText: input,
      packages: ["@render-harness/runtime-cron"],
    });
    expect(next).toBe(input);
  });

  it("falls back to * when no harness deps are present", () => {
    const input = JSON.stringify({ dependencies: { lodash: "^4" } }, null, 2);
    const next = mutatePackageJsonAddRuntimeDeps({
      jsonText: input,
      packages: ["@render-harness/runtime-cron"],
    });
    const parsed = JSON.parse(next) as { dependencies: Record<string, string> };
    expect(parsed.dependencies["@render-harness/runtime-cron"]).toBe("*");
  });

  it("adds multiple packages in one call", () => {
    const input = JSON.stringify({ dependencies: { "@render-harness/core": "^0.5" } }, null, 2);
    const next = mutatePackageJsonAddRuntimeDeps({
      jsonText: input,
      packages: ["@render-harness/runtime-cron", "@render-harness/runtime-workflows"],
    });
    const parsed = JSON.parse(next) as { dependencies: Record<string, string> };
    expect(parsed.dependencies["@render-harness/runtime-cron"]).toBe("^0.5");
    expect(parsed.dependencies["@render-harness/runtime-workflows"]).toBe("^0.5");
  });
});

describe("mutateEnvExampleForAgent", () => {
  it("appends missing env vars under an agent-id header", () => {
    const next = mutateEnvExampleForAgent({
      text: "EXISTING=\n",
      agentId: "meeting-prep",
      envVars: ["CALENDAR_ICS_URL", "OTHER_KEY"],
    });
    expect(next).toContain("# Added agent: meeting-prep");
    expect(next).toMatch(/CALENDAR_ICS_URL=\n/);
    expect(next).toMatch(/OTHER_KEY=\n/);
  });

  it("returns input unchanged when all vars exist", () => {
    const input = "FOO=\nBAR=\n";
    const next = mutateEnvExampleForAgent({
      text: input,
      agentId: "meeting-prep",
      envVars: ["FOO", "BAR"],
    });
    expect(next).toBe(input);
  });

  it("noops when envVars is empty", () => {
    const input = "FOO=\n";
    const next = mutateEnvExampleForAgent({
      text: input,
      agentId: "meeting-prep",
      envVars: [],
    });
    expect(next).toBe(input);
  });
});

function _typeGuard(_plan: AgentAddPlan): void {
  // Compile-time check that AgentAddPlan is exported.
}
