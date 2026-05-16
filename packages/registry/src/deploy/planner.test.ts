import { describe, expect, it } from "vitest";
import { emitBlueprint } from "../emitter.js";
import { HarnessConfigSchema } from "../schema.js";
import { planFromBlueprint } from "./planner.js";

const ANTHROPIC_MODEL = { provider: "anthropic", model: "claude-sonnet-4-6" } as const;

async function planForBundle(manifest: unknown) {
  const config = HarnessConfigSchema.parse(manifest);
  const { blueprint } = await emitBlueprint({
    config,
    packageName: "@render-harness/example-test",
  });
  return planFromBlueprint({
    blueprint,
    config,
    ownerId: "tea-owner",
    repoUrl: "https://github.com/test/repo",
    branch: "main",
    packageName: "@render-harness/example-test",
    region: "oregon",
  });
}

describe("planFromBlueprint", () => {
  it("emits one postgres, no KV, one web service for a single-agent web bundle", async () => {
    const plan = await planForBundle({
      schemaVersion: 1,
      name: "demo",
      description: "x",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL },
      agents: [
        {
          id: "demo",
          agent: { kind: "builtin", ref: "chat", systemPrompt: "x" },
          runtimes: [{ kind: "web" }],
        },
      ],
    });
    const kinds = plan.resources.map((r) => `${r.kind}:${"subkind" in r ? r.subkind : ""}`);
    expect(kinds).toEqual(["postgres:", "service:web_service"]);
  });

  it("plans a chief-of-staff-shape bundle: db + KV + web + worker + 1 inline cron + 2 cron-triggers + 1 workflow", async () => {
    const plan = await planForBundle({
      schemaVersion: 1,
      name: "chief-of-staff",
      description: "x",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL, ui: true },
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
          workflowTask: true,
          agent: { kind: "custom", entrypoint: "./src/weekly-recap.ts" },
          runtimes: [{ kind: "cron", schedule: "0 17 * * 5", via: "workflow" }],
        },
        {
          id: "interview-prep",
          workflowTask: true,
          agent: { kind: "custom", entrypoint: "./src/interview-prep.ts" },
          runtimes: [{ kind: "cron", schedule: "0 12 * * 1-5", via: "workflow" }],
        },
        {
          id: "interview-feedback",
          workflowTask: true,
          agent: { kind: "custom", entrypoint: "./src/interview-feedback.ts" },
          runtimes: [{ kind: "workflows" }],
        },
      ],
    });
    const names = plan.resources.map((r) => r.name).sort();
    const worker = plan.resources.find((r) => r.name === "chief-of-staff-worker");
    expect(worker).toMatchObject({ kind: "service", subkind: "background_worker" });
    expect(names).toEqual([
      "chief-of-staff-cron-meeting-prep",
      "chief-of-staff-cron-trigger-interview-prep",
      "chief-of-staff-cron-trigger-weekly-recap",
      "chief-of-staff-db",
      "chief-of-staff-kv",
      "chief-of-staff-web",
      "chief-of-staff-worker",
      "chief-of-staff-workflows",
    ]);
    // The workflow runs every workflow-task agent — verify it exists and
    // its body references the runCommand we expect.
    const wf = plan.resources.find((r) => r.kind === "workflow");
    expect(wf).toBeDefined();
    if (wf?.kind === "workflow") {
      expect(wf.body.region).toBe("oregon");
      expect(wf.body.buildConfig.runCommand).toContain("dist/workflows.js");
      // DATABASE_URL must resolve from the bundle's db at runtime.
      const dbEnv = wf.body.envVars?.find((e) => e.key === "DATABASE_URL");
      expect(dbEnv?.value).toContain("__RESOLVE_FROM_DATABASE:chief-of-staff-db");
    }
  });

  it("workflow service body carries the bundle's manifest-declared env vars", async () => {
    const plan = await planForBundle({
      schemaVersion: 1,
      name: "with-env",
      description: "x",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL },
      envSchema: [{ name: "CALENDAR_ICS_URL", required: false, secret: true }],
      agents: [
        {
          id: "wfonly",
          workflowTask: true,
          agent: { kind: "custom", entrypoint: "./src/wfonly.ts" },
          runtimes: [{ kind: "workflows" }],
        },
      ],
    });
    const wf = plan.resources.find((r) => r.kind === "workflow");
    expect(wf?.kind).toBe("workflow");
    if (wf?.kind === "workflow") {
      const calendar = wf.body.envVars?.find((e) => e.key === "CALENDAR_ICS_URL");
      expect(calendar).toBeDefined();
      expect(calendar?.isSensitive).toBe(true);
    }
  });

  it("emits no workflow resource when the bundle has no workflow-task agents", async () => {
    const plan = await planForBundle({
      schemaVersion: 1,
      name: "no-wf",
      description: "x",
      harnessVersion: "^0.1",
      shared: { model: ANTHROPIC_MODEL },
      agents: [
        {
          id: "no-wf",
          agent: { kind: "custom", entrypoint: "./src/no-wf.ts" },
          runtimes: [{ kind: "web" }, { kind: "cron", schedule: "0 0 * * *" }],
        },
      ],
    });
    expect(plan.resources.find((r) => r.kind === "workflow")).toBeUndefined();
  });
});
