import { describe, expect, it } from "vitest";
import { emitBlueprint } from "./emitter.js";
import { HarnessConfigSchema } from "./schema.js";

const ANTHROPIC_MODEL = { provider: "anthropic", model: "claude-sonnet-4-6" } as const;

describe("emitBlueprint — runtime shape mapping", () => {
  it("emits a single web service for runtimes:[web] (matches render.demo.yaml)", async () => {
    const config = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "web-chat",
      description: "Demo web agent.",
      harnessVersion: "^0.1",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "Hi." },
      runtimes: [{ kind: "web", plan: "starter" }],
      model: ANTHROPIC_MODEL,
    });
    const { blueprint } = await emitBlueprint({
      config,
      packageName: "@render-harness/example-web-chat",
    });
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

  it("emits a cron service for runtimes:[cron] (matches render.demo-cron.yaml)", async () => {
    const config = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "citations-monitor",
      description: "Daily AEO audit.",
      harnessVersion: "^0.1",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "Audit." },
      runtimes: [{ kind: "cron", schedule: "0 13 * * *", plan: "starter" }],
      model: ANTHROPIC_MODEL,
    });
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

  it("emits public web + worker pserv + KV for runtimes:[web,worker] (matches render.private.yaml)", async () => {
    const config = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "support-agent",
      description: "Slack support agent on the private network.",
      harnessVersion: "^0.1",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "Help." },
      runtimes: [
        { kind: "web", plan: "starter" },
        { kind: "worker", plan: "starter" },
      ],
      model: ANTHROPIC_MODEL,
      envSchema: [
        { name: "SLACK_BOT_TOKEN", required: true, secret: true },
        { name: "SLACK_SIGNING_SECRET", required: true, secret: true },
      ],
    });
    const { blueprint } = await emitBlueprint({
      config,
      packageName: "@render-harness/example-support-agent",
    });
    const services = blueprint.services ?? [];
    // Expected: keyvalue + web + worker pserv (3 services)
    expect(services.map((s) => s.type)).toEqual(["keyvalue", "web", "pserv"]);
    expect(services.find((s) => s.type === "web")?.name).toBe("support-agent-web");
    expect(services.find((s) => s.type === "pserv")?.name).toBe("support-agent-worker");
    expect(services.find((s) => s.type === "keyvalue")?.name).toBe("support-agent-kv");
    // The web shell wires KV via fromService
    const web = services.find((s) => s.type === "web");
    expect(web?.envVars?.find((e) => e.key === "KV_URL")?.fromService).toMatchObject({
      name: "support-agent-kv",
      type: "keyvalue",
      property: "connectionString",
    });
    // Worker has the model API key as a sync:false secret
    const worker = services.find((s) => s.type === "pserv");
    expect(worker?.envVars?.find((e) => e.key === "ANTHROPIC_API_KEY")?.sync).toBe(false);
    // Worker's queue is named after the entry
    expect(worker?.envVars?.find((e) => e.key === "WORKER_QUEUE")?.value).toBe(
      "support-agent-runs",
    );
  });

  it("records a Dashboard step and a warning for kind:workflows", async () => {
    const config = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "deploy-agent",
      description: "Workflows-driven deploy agent.",
      harnessVersion: "^0.1",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "Deploy." },
      runtimes: [{ kind: "workflows", plan: "starter" }],
      model: ANTHROPIC_MODEL,
    });
    const { blueprint, dashboardSteps, warnings } = await emitBlueprint({ config });
    expect(blueprint.services ?? []).toHaveLength(0);
    expect(dashboardSteps).toHaveLength(1);
    expect(dashboardSteps[0]).toContain("Workflow service");
    expect(warnings.some((w) => /Workflows aren't yet supported/.test(w))).toBe(true);
  });
});

describe("emitBlueprint — env schema merging", () => {
  it("auto-injects ANTHROPIC_API_KEY when provider=anthropic", async () => {
    const config = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "demo",
      description: "x",
      harnessVersion: "^0.1",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "x" },
      runtimes: [{ kind: "web" }],
      model: ANTHROPIC_MODEL,
    });
    const { effectiveEnvSchema } = await emitBlueprint({ config });
    expect(effectiveEnvSchema.find((e) => e.name === "ANTHROPIC_API_KEY")).toMatchObject({
      required: true,
      secret: true,
    });
  });

  it("respects explicit envSchema entries from the config", async () => {
    const config = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "demo",
      description: "x",
      harnessVersion: "^0.1",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "x" },
      runtimes: [{ kind: "web" }],
      model: ANTHROPIC_MODEL,
      envSchema: [
        { name: "CUSTOM_THING", required: true, secret: false, description: "Doc." },
      ],
    });
    const { effectiveEnvSchema } = await emitBlueprint({ config });
    expect(effectiveEnvSchema.find((e) => e.name === "CUSTOM_THING")).toMatchObject({
      required: true,
      secret: false,
      description: "Doc.",
    });
  });
});

describe("emitBlueprint — serialized output", () => {
  it("produces a yaml-language-server header", async () => {
    const config = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "demo",
      description: "x",
      harnessVersion: "^0.1",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "x" },
      runtimes: [{ kind: "web" }],
      model: ANTHROPIC_MODEL,
    });
    const { yaml } = await emitBlueprint({ config });
    expect(yaml).toContain("yaml-language-server: $schema=");
    expect(yaml).toContain("Generated by `render-harness-build`");
    expect(yaml).toContain("databases:");
    expect(yaml).toContain("services:");
  });
});
