import { describe, expect, it } from "vitest";
import { emitBlueprint } from "./emitter.js";
import { HarnessConfigSchema } from "./schema.js";

const ANTHROPIC_MODEL = { provider: "anthropic", model: "claude-sonnet-4-6" } as const;

/**
 * Convenience for building single-agent manifests in test fixtures.
 * Wraps `agent`/`runtimes` in the canonical `agents[]` shape and
 * promotes `model` to `shared`.
 */
function singleAgent(opts: {
  name: string;
  description: string;
  systemPrompt: string;
  runtimes: Array<Record<string, unknown>>;
  envSchema?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: opts.name,
    description: opts.description,
    harnessVersion: "^0.1",
    shared: { model: ANTHROPIC_MODEL },
    ...(opts.envSchema ? { envSchema: opts.envSchema } : {}),
    agents: [
      {
        id: opts.name,
        agent: { kind: "builtin", ref: "chat", systemPrompt: opts.systemPrompt },
        runtimes: opts.runtimes,
      },
    ],
  };
}

describe("emitBlueprint — runtime shape mapping", () => {
  it("emits a single web service for an agent with [web] runtime", async () => {
    const config = HarnessConfigSchema.parse(
      singleAgent({
        name: "web-chat",
        description: "Demo web agent.",
        systemPrompt: "Hi.",
        runtimes: [{ kind: "web", plan: "starter" }],
      }),
    );
    const { blueprint, yaml } = await emitBlueprint({
      config,
      packageName: "@render-harness/example-web-chat",
    });
    expect(blueprint.projects?.[0]?.name).toBe("web-chat");
    expect(blueprint.projects?.[0]?.environments[0]?.name).toBe("production");
    expect(yaml).toContain("projects:");
    expect(yaml).toContain("envVarGroups:");
    expect(yaml).not.toMatch(/^services:/m);
    expect(yaml).not.toMatch(/type: keyvalue[\s\S]*?envVars:/);
    expect(blueprint.databases).toEqual([
      {
        name: "web-chat-db",
        plan: "basic-256mb",
        region: "oregon",
        postgresMajorVersion: "17",
      },
    ]);
    expect(blueprint.services).toHaveLength(1);
    const web = blueprint.services?.[0];
    expect(web?.type).toBe("web");
    expect(web?.name).toBe("web-chat");
    expect(web?.healthCheckPath).toBe("/healthz");
    expect(web?.envVars?.find((e) => e.key === "DATABASE_URL")?.fromDatabase).toMatchObject({
      name: "web-chat-db",
      property: "connectionString",
    });
    expect(web?.envVars?.find((e) => e.key === "ANTHROPIC_API_KEY")?.sync).toBe(false);
  });

  it("emits a cron service for an agent with [cron] runtime", async () => {
    const config = HarnessConfigSchema.parse(
      singleAgent({
        name: "citations-monitor",
        description: "Daily AEO audit.",
        systemPrompt: "Audit.",
        runtimes: [{ kind: "cron", schedule: "0 13 * * *", plan: "starter" }],
      }),
    );
    const { blueprint } = await emitBlueprint({
      config,
      packageName: "@render-harness/example-citations-monitor",
    });
    const services = blueprint.services ?? [];
    expect(services).toHaveLength(1);
    expect(services[0]?.type).toBe("cron");
    expect(services[0]?.schedule).toBe("0 13 * * *");
    expect(services[0]?.startCommand).toContain("examples/citations-monitor/dist/main.js");
  });

  it("emits public web + worker pserv + KV for an agent with [web,worker] runtimes", async () => {
    const config = HarnessConfigSchema.parse(
      singleAgent({
        name: "support-agent",
        description: "Slack support agent on the private network.",
        systemPrompt: "Help.",
        runtimes: [
          { kind: "web", plan: "starter" },
          { kind: "worker", plan: "starter" },
        ],
        envSchema: [
          { name: "SLACK_BOT_TOKEN", required: true, secret: true },
          { name: "SLACK_SIGNING_SECRET", required: true, secret: true },
        ],
      }),
    );
    const { blueprint } = await emitBlueprint({
      config,
      packageName: "@render-harness/example-support-agent",
    });
    const services = blueprint.services ?? [];
    expect(services.map((s) => s.type)).toEqual(["keyvalue", "web", "pserv"]);
    expect(services.find((s) => s.type === "web")?.name).toBe("support-agent-web");
    expect(services.find((s) => s.type === "pserv")?.name).toBe("support-agent-worker");
    expect(services.find((s) => s.type === "keyvalue")?.name).toBe("support-agent-kv");
    expect(services.find((s) => s.type === "keyvalue")?.plan).toBe("starter");
    const web = services.find((s) => s.type === "web");
    expect(web?.envVars?.find((e) => e.key === "KV_URL")?.fromService).toMatchObject({
      name: "support-agent-kv",
      type: "keyvalue",
      property: "connectionString",
    });
    const worker = services.find((s) => s.type === "pserv");
    expect(worker?.envVars?.find((e) => e.key === "ANTHROPIC_API_KEY")?.sync).toBe(false);
    expect(worker?.envVars?.find((e) => e.key === "WORKER_QUEUE")?.value).toBe(
      "support-agent-runs",
    );
  });

  it("records a Dashboard step and a warning for kind:workflows", async () => {
    const config = HarnessConfigSchema.parse(
      singleAgent({
        name: "deploy-agent",
        description: "Workflows-driven deploy agent.",
        systemPrompt: "Deploy.",
        runtimes: [{ kind: "workflows", plan: "starter" }],
      }),
    );
    const { blueprint, dashboardSteps, warnings } = await emitBlueprint({ config });
    expect(blueprint.services ?? []).toHaveLength(0);
    expect(dashboardSteps).toHaveLength(1);
    expect(dashboardSteps[0]).toContain("Workflow service");
    expect(warnings.some((w) => /Workflows aren't yet supported/.test(w))).toBe(true);
  });
});

describe("emitBlueprint — env schema merging", () => {
  it("auto-injects ANTHROPIC_API_KEY when provider=anthropic", async () => {
    const config = HarnessConfigSchema.parse(
      singleAgent({
        name: "demo",
        description: "x",
        systemPrompt: "x",
        runtimes: [{ kind: "web" }],
      }),
    );
    const { effectiveEnvSchema } = await emitBlueprint({ config });
    expect(effectiveEnvSchema.find((e) => e.name === "ANTHROPIC_API_KEY")).toMatchObject({
      required: true,
      secret: true,
    });
  });

  it("respects explicit envSchema entries from the config", async () => {
    const config = HarnessConfigSchema.parse(
      singleAgent({
        name: "demo",
        description: "x",
        systemPrompt: "x",
        runtimes: [{ kind: "web" }],
        envSchema: [{ name: "CUSTOM_THING", required: true, secret: false, description: "Doc." }],
      }),
    );
    const { effectiveEnvSchema } = await emitBlueprint({ config });
    expect(effectiveEnvSchema.find((e) => e.name === "CUSTOM_THING")).toMatchObject({
      required: true,
      secret: false,
      description: "Doc.",
    });
  });
});

describe("emitBlueprint — V2 multi-agent bundle", () => {
  const chiefOfStaff = HarnessConfigSchema.parse({
    schemaVersion: 1,
    name: "chief-of-staff",
    description: "Personal chief of staff bundle.",
    harnessVersion: "^0.1",
    shared: { model: ANTHROPIC_MODEL, ui: true },
    capabilities: [{ pack: "@render-harness/cap-memory-pg" }],
    envSchema: [{ name: "CALENDAR_ICS_URL", required: false, secret: true }],
    agents: [
      {
        id: "chat",
        agent: { kind: "custom", entrypoint: "./src/chat.ts" },
        runtimes: [
          { kind: "web", plan: "starter" },
          { kind: "worker", plan: "starter" },
        ],
      },
      {
        id: "meeting-prep",
        agent: { kind: "custom", entrypoint: "./src/meeting-prep.ts" },
        runtimes: [{ kind: "cron", schedule: "*/15 * * * *", plan: "starter" }],
      },
      {
        id: "weekly-recap",
        agent: { kind: "custom", entrypoint: "./src/weekly-recap.ts" },
        runtimes: [{ kind: "cron", schedule: "0 17 * * 5", plan: "starter" }],
      },
    ],
  });

  it("fans out into 1 web + 1 worker + 2 crons + KV + db", async () => {
    const { blueprint } = await emitBlueprint({
      config: chiefOfStaff,
      packageName: "@render-harness/example-chief-of-staff",
    });
    const services = blueprint.services ?? [];
    // 4 application services + 1 KV = 5
    expect(services).toHaveLength(5);
    expect(services.map((s) => s.name).sort()).toEqual([
      "chief-of-staff-cron-meeting-prep",
      "chief-of-staff-cron-weekly-recap",
      "chief-of-staff-kv",
      "chief-of-staff-web",
      "chief-of-staff-worker",
    ]);
    expect(blueprint.databases).toEqual([
      {
        name: "chief-of-staff-db",
        plan: "basic-256mb",
        region: "oregon",
        postgresMajorVersion: "17",
      },
    ]);
  });

  it("emits unique cron service names with HARNESS_AGENT_ID env var", async () => {
    const { blueprint } = await emitBlueprint({
      config: chiefOfStaff,
      packageName: "@render-harness/example-chief-of-staff",
    });
    const services = blueprint.services ?? [];
    const cronA = services.find((s) => s.name === "chief-of-staff-cron-meeting-prep");
    const cronB = services.find((s) => s.name === "chief-of-staff-cron-weekly-recap");
    expect(cronA?.type).toBe("cron");
    expect(cronA?.schedule).toBe("*/15 * * * *");
    expect(cronA?.envVars?.find((e) => e.key === "HARNESS_AGENT_ID")?.value).toBe("meeting-prep");
    expect(cronB?.schedule).toBe("0 17 * * 5");
    expect(cronB?.envVars?.find((e) => e.key === "HARNESS_AGENT_ID")?.value).toBe("weekly-recap");
    // Cron start command uses `cron.js`, not `main.js`, for multi-agent
    expect(cronA?.startCommand).toContain("dist/cron.js");
  });

  it("wires the coalesced web shell to KV and worker queue", async () => {
    const { blueprint } = await emitBlueprint({
      config: chiefOfStaff,
      packageName: "@render-harness/example-chief-of-staff",
    });
    const web = blueprint.services?.find((s) => s.name === "chief-of-staff-web");
    expect(web?.type).toBe("web");
    expect(web?.envVars?.find((e) => e.key === "WORKER_QUEUE")?.value).toBe("chief-of-staff-runs");
    expect(web?.envVars?.find((e) => e.key === "KV_URL")?.fromService).toMatchObject({
      name: "chief-of-staff-kv",
      type: "keyvalue",
      property: "connectionString",
    });
  });

  it("propagates per-agent envSchema entries across all services once", async () => {
    const { blueprint } = await emitBlueprint({
      config: chiefOfStaff,
      packageName: "@render-harness/example-chief-of-staff",
    });
    for (const svc of blueprint.services ?? []) {
      if (svc.type === "keyvalue") continue;
      const calendar = svc.envVars?.filter((e) => e.key === "CALENDAR_ICS_URL");
      expect(calendar).toHaveLength(1);
      expect(calendar?.[0]?.sync).toBe(false);
    }
  });

  it("collects API keys for every model provider referenced (shared + per-agent overrides)", async () => {
    const mixedModels = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "mixed",
      description: "Mixed-provider bundle.",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL },
      agents: [
        {
          id: "chat",
          agent: { kind: "custom", entrypoint: "./src/chat.ts" },
          runtimes: [{ kind: "web" }, { kind: "worker" }],
        },
        {
          id: "cheap-cron",
          agent: { kind: "custom", entrypoint: "./src/cheap.ts" },
          model: { provider: "openai-compat", model: "gpt-4o-mini" },
          runtimes: [{ kind: "cron", schedule: "0 0 * * *" }],
        },
      ],
    });
    const { effectiveEnvSchema } = await emitBlueprint({
      config: mixedModels,
      packageName: "@render-harness/example-mixed",
    });
    expect(effectiveEnvSchema.find((e) => e.name === "ANTHROPIC_API_KEY")).toBeDefined();
    expect(effectiveEnvSchema.find((e) => e.name === "OPENAI_API_KEY")).toBeDefined();
  });

  it("warns when multiple kind:worker agents declare divergent queue names", async () => {
    const divergent = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "div",
      description: "x",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL },
      agents: [
        {
          id: "a",
          agent: { kind: "custom", entrypoint: "./src/a.ts" },
          runtimes: [{ kind: "worker", queue: "queue-a" }],
        },
        {
          id: "b",
          agent: { kind: "custom", entrypoint: "./src/b.ts" },
          runtimes: [{ kind: "worker", queue: "queue-b" }],
        },
      ],
    });
    const { warnings, blueprint } = await emitBlueprint({
      config: divergent,
      packageName: "@render-harness/example-div",
    });
    expect(warnings.some((w) => /divergent queue names/.test(w))).toBe(true);
    // Still emits exactly ONE worker — coalesced.
    expect(blueprint.services?.filter((s) => s.type === "pserv")).toHaveLength(1);
  });

  it("records one consolidated Dashboard step listing every workflow-task agent in the bundle", async () => {
    const wfBundle = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "wf-bundle",
      description: "Two workflows agents.",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL },
      agents: [
        {
          id: "deploy",
          agent: { kind: "custom", entrypoint: "./src/deploy.ts" },
          runtimes: [{ kind: "workflows" }],
        },
        {
          id: "migrate",
          agent: { kind: "custom", entrypoint: "./src/migrate.ts" },
          runtimes: [{ kind: "workflows" }],
        },
      ],
    });
    const { dashboardSteps } = await emitBlueprint({
      config: wfBundle,
      packageName: "@render-harness/example-wf-bundle",
    });
    // One Workflow service hosts every workflow-mode task (Render allows
    // up to 500 tasks per service). The checklist is one line listing
    // both tasks.
    expect(dashboardSteps).toHaveLength(1);
    expect(dashboardSteps[0]).toContain("wf-bundle-workflows");
    expect(dashboardSteps[0]).toContain("`deploy`");
    expect(dashboardSteps[0]).toContain("`migrate`");
  });

  it("emits a cron-trigger service for kind:cron, via:workflow + adds it to the workflow task list", async () => {
    const mixed = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "mixed-cron",
      description: "One inline cron + one workflow-triggered cron.",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL },
      agents: [
        {
          id: "fast-check",
          agent: { kind: "custom", entrypoint: "./src/fast-check.ts" },
          runtimes: [{ kind: "cron", schedule: "*/15 * * * *" }],
        },
        {
          id: "weekly-recap",
          agent: { kind: "custom", entrypoint: "./src/weekly-recap.ts" },
          runtimes: [{ kind: "cron", schedule: "0 17 * * 5", via: "workflow" }],
        },
      ],
    });
    const { blueprint, dashboardSteps } = await emitBlueprint({
      config: mixed,
      packageName: "@render-harness/example-mixed-cron",
    });
    const services = blueprint.services ?? [];
    const cronNames = services.filter((s) => s.type === "cron").map((s) => s.name);
    expect(cronNames.sort()).toEqual([
      "mixed-cron-cron-fast-check",
      "mixed-cron-cron-trigger-weekly-recap",
    ]);

    const trigger = services.find((s) => s.name === "mixed-cron-cron-trigger-weekly-recap");
    // The trigger service runs the trigger entrypoint, not the agent loop.
    expect(trigger?.startCommand).toContain("dist/cron-trigger.js");
    // It carries the task ref so the trigger script knows what to invoke.
    expect(trigger?.envVars?.find((e) => e.key === "WORKFLOW_TASK_REF")?.value).toBe(
      "mixed-cron-workflows/weekly-recap",
    );
    expect(trigger?.envVars?.find((e) => e.key === "WORKFLOW_SLUG")?.value).toBe(
      "mixed-cron-workflows",
    );
    const projectTrigger = blueprint.projects?.[0]?.environments[0]?.services?.find(
      (s) => s.name === "mixed-cron-cron-trigger-weekly-recap",
    );
    // RENDER_API_KEY is shared through the environment group in serialized project YAML.
    expect(projectTrigger?.envVars?.some((e) => e.key === "RENDER_API_KEY")).toBe(false);
    expect(
      blueprint.projects?.[0]?.environments[0]?.envVarGroups?.[0]?.envVars.find(
        (e) => e.key === "RENDER_API_KEY",
      )?.sync,
    ).toBe(false);

    // Trigger services have no model env — they don't run inference.
    expect(trigger?.envVars?.some((e) => e.key === "LLM_MODEL")).toBe(false);

    // The workflow-task agent (weekly-recap) shows up in the Dashboard step.
    expect(dashboardSteps).toHaveLength(1);
    expect(dashboardSteps[0]).toContain("`weekly-recap`");
    expect(dashboardSteps[0]).not.toContain("`fast-check`");
  });

  it("wires WORKFLOW_SLUG locally and RENDER_API_KEY through the env group", async () => {
    const withWorkflowTask = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "delegator",
      description: "Chat that delegates to a workflow.",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL },
      agents: [
        {
          id: "chat",
          agent: { kind: "custom", entrypoint: "./src/chat.ts" },
          runtimes: [{ kind: "web" }, { kind: "worker" }],
        },
        {
          id: "deep-research",
          workflowTask: true,
          agent: { kind: "custom", entrypoint: "./src/deep-research.ts" },
          runtimes: [{ kind: "workflows" }],
        },
      ],
    });
    const { blueprint } = await emitBlueprint({
      config: withWorkflowTask,
      packageName: "@render-harness/example-delegator",
    });
    const web = blueprint.services?.find((s) => s.type === "web");
    const worker = blueprint.services?.find((s) => s.type === "pserv");
    const projectServices = blueprint.projects?.[0]?.environments[0]?.services ?? [];
    const projectWeb = projectServices.find((s) => s.type === "web");
    const projectWorker = projectServices.find((s) => s.type === "pserv");
    expect(web?.envVars?.find((e) => e.key === "WORKFLOW_SLUG")?.value).toBe("delegator-workflows");
    expect(projectWeb?.envVars?.some((e) => e.key === "RENDER_API_KEY")).toBe(false);
    expect(worker?.envVars?.find((e) => e.key === "WORKFLOW_SLUG")?.value).toBe(
      "delegator-workflows",
    );
    expect(projectWorker?.envVars?.some((e) => e.key === "RENDER_API_KEY")).toBe(false);
    expect(
      blueprint.projects?.[0]?.environments[0]?.envVarGroups?.[0]?.envVars.find(
        (e) => e.key === "RENDER_API_KEY",
      )?.sync,
    ).toBe(false);
  });

  it("does NOT wire workflow env when the bundle has no workflow-task agents", async () => {
    const noWorkflows = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "plain",
      description: "Plain web + worker bundle.",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL },
      agents: [
        {
          id: "chat",
          agent: { kind: "custom", entrypoint: "./src/chat.ts" },
          runtimes: [{ kind: "web" }, { kind: "worker" }],
        },
      ],
    });
    const { blueprint } = await emitBlueprint({
      config: noWorkflows,
      packageName: "@render-harness/example-plain",
    });
    const web = blueprint.services?.find((s) => s.type === "web");
    expect(web?.envVars?.some((e) => e.key === "WORKFLOW_SLUG")).toBe(false);
    expect(web?.envVars?.some((e) => e.key === "RENDER_API_KEY")).toBe(false);
  });
});

describe("emitBlueprint — serialized output", () => {
  it("produces a yaml-language-server header", async () => {
    const config = HarnessConfigSchema.parse(
      singleAgent({
        name: "demo",
        description: "x",
        systemPrompt: "x",
        runtimes: [{ kind: "web" }],
      }),
    );
    const { yaml } = await emitBlueprint({ config });
    expect(yaml).toContain("yaml-language-server: $schema=");
    expect(yaml).toContain("Generated by `render-harness-build`");
    expect(yaml).toContain("databases:");
    expect(yaml).toContain("services:");
  });
});
