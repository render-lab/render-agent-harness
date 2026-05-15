/**
 * Bundle-load integration: exercises the real chief-of-staff bundle
 * through the registry manifest pipeline + scaffolder output. Verifies
 * that all five agents (including the new interview-prep + interview-
 * feedback) are correctly:
 *
 *   - parsed via the V2 schema
 *   - classified by `isWorkflowTaskAgent` / `workflowTaskAgents`
 *   - unioned by `flattenRuntimeKinds`
 *   - shipped as verbatim source files in the bundled gallery snapshot
 *   - emitted into the expected Render Blueprint service topology
 *
 * What this does NOT do: invoke `defineAgent()` on the agent TS files
 * directly. Those files import `@render-harness/core`, which doesn't
 * resolve from the gallery dir's bare path (it has no `node_modules`).
 * The unit tests for the agent factories live with the bundle's own
 * `pnpm test` after a real `pnpm install`; the source-text assertions
 * here pin the structural invariants without needing module resolution.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  flattenRuntimeKinds,
  isWorkflowTaskAgent,
  parseHarnessConfigYaml,
  workflowTaskAgents,
} from "@render-harness/registry";
import { loadGalleryFromSource } from "@render-harness/registry/gallery";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..", "..");
const COS_DIR = resolve(HARNESS_ROOT, "gallery", "agents", "chief-of-staff");

async function loadManifest() {
  const text = await readFile(resolve(COS_DIR, "render-harness.yaml"), "utf8");
  return parseHarnessConfigYaml(text);
}

function requireAgent(cfg: Awaited<ReturnType<typeof loadManifest>>, id: string) {
  const agent = cfg.agents.find((a) => a.id === id);
  if (!agent) throw new Error(`expected ${id} agent`);
  return agent;
}

async function loadCosBundle() {
  const gallery = await loadGalleryFromSource({ root: HARNESS_ROOT });
  const cos = gallery.agents.find((a) => a.slug === "chief-of-staff");
  if (!cos) throw new Error("chief-of-staff bundle not in gallery");
  return cos;
}

describe("chief-of-staff bundle — manifest pipeline", () => {
  it("declares all five agents in the expected order", async () => {
    const cfg = await loadManifest();
    expect(cfg.agents.map((a) => a.id)).toEqual([
      "chat",
      "meeting-prep",
      "weekly-recap",
      "interview-prep",
      "interview-feedback",
    ]);
  });

  it("classifies the three workflow-mode agents (weekly-recap, interview-prep, interview-feedback)", async () => {
    const cfg = await loadManifest();
    expect(workflowTaskAgents(cfg).map((a) => a.id)).toEqual([
      "weekly-recap",
      "interview-prep",
      "interview-feedback",
    ]);
    expect(isWorkflowTaskAgent(requireAgent(cfg, "chat"))).toBe(false);
    expect(isWorkflowTaskAgent(requireAgent(cfg, "meeting-prep"))).toBe(false);
  });

  it("flattens runtime kinds across all five agents", async () => {
    const cfg = await loadManifest();
    expect(flattenRuntimeKinds(cfg).sort()).toEqual(["cron", "web", "worker", "workflows"]);
  });

  it("weekly-recap is cron via:workflow", async () => {
    const cfg = await loadManifest();
    const weekly = requireAgent(cfg, "weekly-recap");
    expect(weekly.workflowTask).toBe(true);
    expect(weekly.runtimes).toHaveLength(1);
    expect(weekly.runtimes[0]).toMatchObject({ kind: "cron", via: "workflow" });
  });

  it("interview-prep is cron via:workflow on weekday mornings", async () => {
    const cfg = await loadManifest();
    const prep = requireAgent(cfg, "interview-prep");
    expect(prep.workflowTask).toBe(true);
    expect(prep.runtimes).toHaveLength(1);
    expect(prep.runtimes[0]).toMatchObject({
      kind: "cron",
      via: "workflow",
      schedule: "0 12 * * 1-5",
    });
  });

  it("interview-feedback is workflows-only (no schedule)", async () => {
    const cfg = await loadManifest();
    const feedback = requireAgent(cfg, "interview-feedback");
    expect(feedback.workflowTask).toBe(true);
    expect(feedback.runtimes).toHaveLength(1);
    expect(feedback.runtimes[0]?.kind).toBe("workflows");
  });

  it("chat gates trigger_workflow via requireApproval", async () => {
    const cfg = await loadManifest();
    const chat = requireAgent(cfg, "chat");
    expect(chat.permissions?.requireApproval).toContain("trigger_workflow");
  });
});

describe("chief-of-staff bundle — interview agents source structure", () => {
  it("ships interview-prep.ts as a verbatim bundle source", async () => {
    const cos = await loadCosBundle();
    const prepSource = cos.sourceFiles["src/interview-prep.ts"];
    expect(prepSource).toBeDefined();
    expect(prepSource).toContain(
      'import { type AgentDefinition, defineAgent } from "@render-harness/core"',
    );
    expect(prepSource).toContain('name: "interview-prep"');
    expect(prepSource).toContain("CALENDAR_ICS_URL");
    // The agent's prompt references the namespaced tool names exactly as
    // they're registered (Anthropic-compatible: no slashes, no dots).
    expect(prepSource).toContain("cap-memory-pg__memory_search");
    expect(prepSource).toContain("cap-memory-pg__memory_write");
    // Budget shape is sane for a long-running workflow agent.
    expect(prepSource).toMatch(/maxWallSeconds:\s*1800/);
  });

  it("ships interview-feedback.ts with the HITL memory.write gate", async () => {
    const cos = await loadCosBundle();
    const feedbackSource = cos.sourceFiles["src/interview-feedback.ts"];
    expect(feedbackSource).toBeDefined();
    expect(feedbackSource).toContain('name: "interview-feedback"');
    // The agent gates the final memory.write — this is the load-bearing
    // promise of the workflow shape (user reviews before it lands).
    expect(feedbackSource).toContain('requireApproval: ["cap-memory-pg__memory_write"]');
    // The agent must instruct the model on what to extract from the
    // unstructured user dump. Sanity-check the prompt anchors.
    expect(feedbackSource).toMatch(/strengths/i);
    expect(feedbackSource).toMatch(/weaknesses/i);
    expect(feedbackSource).toMatch(/decision/i);
    // Budget aligns with the manifest's expectations.
    expect(feedbackSource).toMatch(/maxWallSeconds:\s*900/);
  });
});

describe("chief-of-staff bundle — end-to-end emit", () => {
  it("emits the full service topology including a cron-trigger for interview-prep", async () => {
    const { emitBlueprint } = await import("@render-harness/registry/emitter");
    const cos = await loadCosBundle();
    const { blueprint, dashboardSteps } = await emitBlueprint({
      config: cos.manifest,
      packageName: "@render-harness/example-chief-of-staff",
    });

    const services = blueprint.services ?? [];
    const cronTrigger = services.find(
      (s) => s.name === "chief-of-staff-cron-trigger-interview-prep",
    );
    expect(cronTrigger?.type).toBe("cron");
    expect(cronTrigger?.schedule).toBe("0 12 * * 1-5");
    expect(cronTrigger?.startCommand).toContain("dist/cron-trigger.js");
    expect(cronTrigger?.envVars?.find((e) => e.key === "WORKFLOW_TASK_REF")?.value).toBe(
      "chief-of-staff-workflows/interview-prep",
    );

    // interview-feedback has no schedule; it doesn't appear as its own
    // Render service. It only appears as a task on the bundled Workflow
    // service (verified via the dashboard checklist).
    const interviewFeedbackService = services.find((s) => s.name?.includes("interview-feedback"));
    expect(interviewFeedbackService).toBeUndefined();

    // The dashboard checklist lists all three workflow tasks.
    expect(dashboardSteps).toHaveLength(1);
    expect(dashboardSteps[0]).toContain("`weekly-recap`");
    expect(dashboardSteps[0]).toContain("`interview-prep`");
    expect(dashboardSteps[0]).toContain("`interview-feedback`");
  });
});
