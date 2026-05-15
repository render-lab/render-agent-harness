import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGalleryFromSource } from "@render-harness/registry/gallery";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildFileMap } from "./generate.js";
import type { Answers } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..", "..");

describe("end-to-end: chief-of-staff bundle from real gallery", () => {
  it("loads the bundle from gallery/ and scaffolds the expected files", async () => {
    const gallery = await loadGalleryFromSource({ root: HARNESS_ROOT });
    const cos = gallery.agents.find((a) => a.slug === "chief-of-staff");
    expect(cos).toBeDefined();
    if (!cos) return;
    expect(cos.kind).toBe("bundle");
    expect(Object.keys(cos.sourceFiles).sort()).toEqual([
      "src/chat.ts",
      "src/interview-feedback.ts",
      "src/interview-prep.ts",
      "src/meeting-prep.ts",
      "src/weekly-recap.ts",
    ]);

    const answers: Answers = {
      directory: "/tmp/cos-e2e",
      agentName: "chief-of-staff",
      description: cos.description,
      systemPrompt: "",
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      runtimes: [],
      capabilities: cos.capabilities.map((pack) => ({ pack })),
      templateManifest: cos.manifest as unknown as Record<string, unknown>,
      bundle: {
        slug: cos.slug,
        manifest: cos.manifest as unknown as Record<string, unknown>,
        sourceFiles: cos.sourceFiles,
        runtimeKinds: cos.runtimeKinds,
        capabilities: cos.capabilities,
      },
      ui: true,
      packageManager: "pnpm",
      harnessRoot: null,
      gitInit: false,
      installDeps: false,
    };

    const map = buildFileMap(answers);

    // Bundle's verbatim source files survive intact.
    expect(map.get("src/chat.ts")).toBe(cos.sourceFiles["src/chat.ts"]);
    expect(map.get("src/meeting-prep.ts")).toBe(cos.sourceFiles["src/meeting-prep.ts"]);
    expect(map.get("src/weekly-recap.ts")).toBe(cos.sourceFiles["src/weekly-recap.ts"]);
    expect(map.get("src/interview-prep.ts")).toBe(cos.sourceFiles["src/interview-prep.ts"]);
    expect(map.get("src/interview-feedback.ts")).toBe(cos.sourceFiles["src/interview-feedback.ts"]);

    // Generated runtime entries are V2-aware.
    expect(map.get("src/web.ts")).toContain("defineFromConfig");
    expect(map.get("src/web.ts")).toContain("agentsById");
    expect(map.get("src/worker.ts")).toContain("startWorkerAndWait");
    expect(map.get("src/worker.ts")).toContain("job.agentName");
    expect(map.get("src/cron.ts")).toContain("HARNESS_AGENT_ID");

    // Manifest declares all agents.
    const manifest = parseYaml(map.get("render-harness.yaml") ?? "") as {
      schemaVersion: number;
      agents: Array<{ id: string }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.agents.map((a) => a.id)).toEqual([
      "chat",
      "meeting-prep",
      "weekly-recap",
      "interview-prep",
      "interview-feedback",
    ]);

    // Package.json wires up V2 deps.
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@render-harness/web"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/runtime-worker"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/cap-memory-pg"]).toBeDefined();
    // meeting-prep is inline cron → pulls runtime-cron.
    expect(pkg.dependencies["@render-harness/runtime-cron"]).toBeDefined();
    // weekly-recap is via:workflow + workflowTask → pulls runtime-workflows + SDK.
    expect(pkg.dependencies["@render-harness/runtime-workflows"]).toBeDefined();
    expect(pkg.dependencies["@renderinc/sdk"]).toBeDefined();

    // The scaffold ships THREE runtime entries for crons in this bundle:
    //   - src/cron.ts          (inline mode, for meeting-prep)
    //   - src/cron-trigger.ts  (workflow mode, for weekly-recap)
    //   - src/workflows.ts     (registers weekly-recap as a Workflow task)
    expect(map.get("src/cron.ts")).toContain("HARNESS_AGENT_ID");
    expect(map.get("src/cron-trigger.ts")).toContain("triggerAgentWorkflow");
    expect(map.get("src/cron-trigger.ts")).toContain("WORKFLOW_TASK_REF");
    expect(map.get("src/workflows.ts")).toContain("isWorkflowTaskAgent");
    expect(map.get("src/workflows.ts")).toContain('from "@renderinc/sdk/workflows"');

    // The manifest carries the new V2 schema additions verbatim.
    const fullManifest = parseYaml(map.get("render-harness.yaml") ?? "") as {
      agents: Array<{
        id: string;
        workflowTask?: boolean;
        runtimes: Array<{ kind: string; via?: string }>;
        permissions?: { requireApproval?: string[] };
      }>;
    };
    const weekly = fullManifest.agents.find((a) => a.id === "weekly-recap");
    expect(weekly?.workflowTask).toBe(true);
    expect(weekly?.runtimes[0]?.via).toBe("workflow");
    const chat = fullManifest.agents.find((a) => a.id === "chat");
    expect(chat?.permissions?.requireApproval).toContain("trigger_workflow");

    // Interview agents
    const interviewPrep = fullManifest.agents.find((a) => a.id === "interview-prep");
    expect(interviewPrep?.workflowTask).toBe(true);
    // interview-prep has a weekday-morning cron in workflow mode.
    expect(interviewPrep?.runtimes[0]?.kind).toBe("cron");
    expect(interviewPrep?.runtimes[0]?.via).toBe("workflow");

    const interviewFeedback = fullManifest.agents.find((a) => a.id === "interview-feedback");
    expect(interviewFeedback?.workflowTask).toBe(true);
    // interview-feedback is workflow-only, no cron — kind: workflows.
    expect(interviewFeedback?.runtimes[0]?.kind).toBe("workflows");
    // The agent's TS source declares requireApproval on memory.write.
    // The manifest doesn't carry permissions for custom agents (they live
    // in `defineAgent({...})`), so verify it in the source file instead.
    // Tool names follow the Anthropic-compatible namespacing convention.
    expect(cos.sourceFiles["src/interview-feedback.ts"]).toContain("cap-memory-pg__memory_write");
  });

  it("emits a render.yaml matching the expected service topology for the new chief-of-staff", async () => {
    // emitBlueprint isn't surfaced on the package index; it lives in
    // `@render-harness/registry/emitter` (a subpath export). Import it
    // directly to exercise the bundle → Blueprint pipeline here.
    const { emitBlueprint } = await import("@render-harness/registry/emitter");
    const gallery = await loadGalleryFromSource({ root: HARNESS_ROOT });
    const cos = gallery.agents.find((a) => a.slug === "chief-of-staff");
    if (!cos) throw new Error("chief-of-staff bundle not found");

    const { blueprint, dashboardSteps } = await emitBlueprint({
      config: cos.manifest,
      packageName: "@render-harness/example-chief-of-staff",
    });
    const services = blueprint.services ?? [];
    const names = services.map((s) => s.name).sort();
    // Expected services:
    //   chief-of-staff-cron-meeting-prep                (inline cron)
    //   chief-of-staff-cron-trigger-interview-prep      (via: workflow)
    //   chief-of-staff-cron-trigger-weekly-recap        (via: workflow)
    //   chief-of-staff-kv
    //   chief-of-staff-web
    //   chief-of-staff-worker
    expect(names).toEqual([
      "chief-of-staff-cron-meeting-prep",
      "chief-of-staff-cron-trigger-interview-prep",
      "chief-of-staff-cron-trigger-weekly-recap",
      "chief-of-staff-kv",
      "chief-of-staff-web",
      "chief-of-staff-worker",
    ]);

    // One consolidated Workflow-service Dashboard step listing all three workflow tasks.
    expect(dashboardSteps).toHaveLength(1);
    expect(dashboardSteps[0]).toContain("chief-of-staff-workflows");
    expect(dashboardSteps[0]).toContain("`weekly-recap`");
    expect(dashboardSteps[0]).toContain("`interview-prep`");
    expect(dashboardSteps[0]).toContain("`interview-feedback`");
  });
});

// Module exists; reference the path constants so unused-var lint stays quiet
// when this test file becomes ESM-only.
void join;
