/**
 * Schemas for the Render harness config registry.
 *
 * Three schemas live here:
 *
 *   - {@link HarnessConfigSchema} — `render-harness.yaml`, the entry-side
 *     declarative config. Shipped at the root of every entry repo.
 *   - {@link IndexSchema} — `index.json`, the central catalog file in the
 *     decentralized index repo.
 *   - {@link EnvVarSpecSchema} — env-var requirement entries used by both
 *     entries and capability packs.
 *
 * The schemas are written with Zod so we get one place that validates
 * runtime inputs (the config loader, the build bin, the index CI) AND
 * serves as the source of truth for TS types via `z.infer`.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ----------------------------------------------------------------------
// Shared primitives
// ----------------------------------------------------------------------

const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must match [a-z0-9][a-z0-9-]*");

export const SemverRangeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[~^<>=*xX0-9a-zA-Z._| -]+$/, "must be an npm-style semver range")
  .describe("npm-style semver range, e.g. ^0.1 or 0.2.x");

const sha40Schema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase git commit SHA");

/**
 * Env-var requirements declared by entries or contributed by capability
 * packs. Surfaced to the user at deploy time and merged into render.yaml.
 */
export const EnvVarSpecSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "env var names are SHOUT_CASE")
      .max(64),
    required: z.boolean().default(false),
    secret: z.boolean().default(false),
    description: z.string().max(500).optional(),
    /** Optional default value rendered into render.yaml when not secret. */
    default: z.string().max(500).optional(),
  })
  .strict();

export type EnvVarSpec = z.infer<typeof EnvVarSpecSchema>;

// ----------------------------------------------------------------------
// MCP server config (mirrors @render-harness/core's McpServerConfig but as
// a Zod schema so we can validate YAML input before handing to the core).
// ----------------------------------------------------------------------

const McpStdioSchema = z
  .object({
    name: z.string().min(1).max(64),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    allowTools: z.array(z.string()).optional(),
  })
  .strict();

const McpHttpSchema = z
  .object({
    name: z.string().min(1).max(64),
    transport: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    allowTools: z.array(z.string()).optional(),
  })
  .strict();

export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  McpStdioSchema,
  McpHttpSchema,
]);

export type McpServerConfigInput = z.infer<typeof McpServerConfigSchema>;

// ----------------------------------------------------------------------
// Model spec
// ----------------------------------------------------------------------

export const ModelSpecSchema = z
  .object({
    provider: z.enum(["anthropic", "openai-compat"]),
    model: z.string().min(1).max(128),
    baseURL: z.string().url().optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    thinking: z
      .object({
        enabled: z.literal(true),
        budgetTokens: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSpecInput = z.infer<typeof ModelSpecSchema>;

// ----------------------------------------------------------------------
// Sampling
// ----------------------------------------------------------------------

export const SamplingParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict();

export type SamplingParamsInput = z.infer<typeof SamplingParamsSchema>;

// ----------------------------------------------------------------------
// Permissions
// ----------------------------------------------------------------------

export const PermissionsSchema = z
  .object({
    requireApproval: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    deniedTools: z.array(z.string()).optional(),
  })
  .strict();

export type PermissionsInput = z.infer<typeof PermissionsSchema>;

// ----------------------------------------------------------------------
// Budget overrides (mirrors core Budget but partial)
// ----------------------------------------------------------------------

export const BudgetSchema = z
  .object({
    maxIterations: z.number().int().positive().optional(),
    maxWallSeconds: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
  })
  .strict();

export type BudgetInput = z.infer<typeof BudgetSchema>;

// ----------------------------------------------------------------------
// Agent block — kind=builtin or kind=custom
// ----------------------------------------------------------------------

const AgentBuiltinSchema = z
  .object({
    kind: z.literal("builtin"),
    /** Built-in kind reference. v1 ships only "chat". */
    ref: z.literal("chat"),
    /** System prompt the chat builtin uses. */
    systemPrompt: z.string().min(1).max(50_000),
  })
  .strict();

const AgentCustomSchema = z
  .object({
    kind: z.literal("custom"),
    /**
     * Path to a TypeScript / compiled JavaScript module whose default
     * export is an `AgentDefinition` (or a function that returns one).
     * Resolved relative to the entry repo root.
     */
    entrypoint: z
      .string()
      .min(1)
      .max(512)
      .regex(/^\.?\/?[\w./@-]+$/, "must be a relative path"),
  })
  .strict();

export const AgentBlockSchema = z.discriminatedUnion("kind", [
  AgentBuiltinSchema,
  AgentCustomSchema,
]);

export type AgentBlockInput = z.infer<typeof AgentBlockSchema>;

// ----------------------------------------------------------------------
// Runtimes block
//
// Each entry can declare 1..N runtimes. The Blueprint emitter inspects the
// combination to decide whether to emit `runtime-web` (single-process) or
// `packages/web` + `runtime-worker` background worker (multi-tenant).
// ----------------------------------------------------------------------

const planSchema = z
  .enum([
    "free",
    "starter",
    "standard",
    "pro",
    "pro_plus",
    "pro_max",
    "pro_ultra",
    "basic-256mb",
    "basic-1gb",
  ])
  .describe("Render plan / instance type");

const RuntimeWebSchema = z
  .object({
    kind: z.literal("web"),
    plan: planSchema.optional(),
    healthCheckPath: z.string().regex(/^\//, "health-check path must start with /").optional(),
    region: z.string().min(1).max(32).optional(),
  })
  .strict();

const RuntimeWorkerSchema = z
  .object({
    kind: z.literal("worker"),
    plan: planSchema.optional(),
    region: z.string().min(1).max(32).optional(),
    /** pg-boss queue name. Defaults to "agent-runs". */
    queue: z.string().min(1).max(64).optional(),
  })
  .strict();

const RuntimeCronSchema = z
  .object({
    kind: z.literal("cron"),
    plan: planSchema.optional(),
    region: z.string().min(1).max(32).optional(),
    /** UTC cron expression. Quoted in YAML. */
    schedule: z.string().min(1).max(100),
    /**
     * What the cron service does:
     *   - "cron" (default) — runs the agent inline. The cron service
     *     executes the full agent loop and exits. Right for short,
     *     fail-stop, no-HITL work.
     *   - "workflow" — emits a thin Cron service whose only job is to
     *     call `render.workflows.runTask` (via `@renderinc/sdk`) and
     *     exit. The actual agent run executes in the bundle's Workflow
     *     service. Implies `workflowTask: true` on the owning agent.
     *
     * Workflow-mode crons need `RENDER_API_KEY` and `WORKFLOW_SLUG` env
     * vars at deploy time (the emitter wires them).
     */
    via: z.enum(["cron", "workflow"]).optional(),
  })
  .strict();

const RuntimeWorkflowsSchema = z
  .object({
    kind: z.literal("workflows"),
    /**
     * Workflows can't be Blueprinted today (architecture verification 2);
     * the emitter prints a Dashboard checklist instead of a service block.
     * Plan/region are still recorded for the README the build bin
     * generates.
     */
    plan: planSchema.optional(),
    region: z.string().min(1).max(32).optional(),
  })
  .strict();

export const RuntimeBlockSchema = z.discriminatedUnion("kind", [
  RuntimeWebSchema,
  RuntimeWorkerSchema,
  RuntimeCronSchema,
  RuntimeWorkflowsSchema,
]);

export type RuntimeBlockInput = z.infer<typeof RuntimeBlockSchema>;

// ----------------------------------------------------------------------
// Capability pack reference
// ----------------------------------------------------------------------

export const CapabilityRefSchema = z
  .object({
    /** npm package name implementing the CapabilityPack contract. */
    pack: z
      .string()
      .min(1)
      .max(214)
      .regex(
        /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
        "must be a valid npm package name",
      ),
    /** npm-style semver range. Optional — the entry's package.json is the source of truth. */
    version: SemverRangeSchema.optional(),
    /** Free-form user config object passed to the pack at load time. */
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CapabilityRef = z.infer<typeof CapabilityRefSchema>;

// ----------------------------------------------------------------------
// Top-level render-harness.yaml schema
//
// One manifest declares N agents that share one Render deployment
// (Postgres + KV + coalesced web + coalesced worker + N cron services +
// optionally one Workflow service). A "single-agent" entry is just a
// manifest with one item in `agents[]`.
// ----------------------------------------------------------------------

/**
 * Per-agent block. Each entry carries its own agent definition + runtime
 * set + optional model / permissions / budget / sampling / mcpServers
 * overrides that fall back to {@link SharedBlock} when omitted.
 *
 * Per-agent `capabilities` are intentionally **not** modeled — capability
 * packs are module-level singletons (e.g. the `bootstrapped` flag in
 * `cap-memory-pg`), so they live at the bundle level.
 */
export const AgentEntrySchema = z
  .object({
    id: slugSchema,
    description: z.string().min(1).max(280).optional(),
    agent: AgentBlockSchema,
    runtimes: z.array(RuntimeBlockSchema).min(1).max(8),
    model: ModelSpecSchema.optional(),
    permissions: PermissionsSchema.optional(),
    budget: BudgetSchema.optional(),
    sampling: SamplingParamsSchema.optional(),
    mcpServers: z.array(McpServerConfigSchema).optional(),
    /**
     * Register this agent as a task on the bundle's single Workflow
     * service. The task is callable from other agents (via the
     * `trigger_workflow` builtin), from cron services declared with
     * `via: workflow`, or from any external system using the Render
     * Workflows SDK.
     *
     * Implicitly true when the agent has `kind: workflows` runtime or
     * any `kind: cron, via: workflow` runtime. Set explicitly when you
     * want an agent to be workflow-callable without any in-bundle
     * trigger (the chat agent invokes it on demand).
     */
    workflowTask: z.boolean().optional(),
  })
  .strict()
  .superRefine((agent, ctx) => {
    // Within one agent, no two runtimes may share a kind. Cross-agent
    // duplication is fine — the emitter coalesces web/worker into one
    // service each and fans cron out to N services.
    const seen = new Set<string>();
    for (const r of agent.runtimes) {
      if (seen.has(r.kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["runtimes"],
          message: `agent "${agent.id}" declares duplicate runtime kind "${r.kind}"; each kind may appear at most once per agent`,
        });
      }
      seen.add(r.kind);
    }
  });

export type AgentEntryInput = z.infer<typeof AgentEntrySchema>;

/**
 * Bundle-wide defaults applied to every agent unless the agent overrides.
 * `ui: true` mounts `@render-harness/ui` on the coalesced web service.
 */
export const SharedBlockSchema = z
  .object({
    model: ModelSpecSchema.optional(),
    ui: z.boolean().optional(),
    budget: BudgetSchema.optional(),
    sampling: SamplingParamsSchema.optional(),
    permissions: PermissionsSchema.optional(),
  })
  .strict();

export type SharedBlockInput = z.infer<typeof SharedBlockSchema>;

export const HarnessConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: slugSchema,
    description: z.string().min(1).max(280),
    /** Compatible @render-harness/core version range. */
    harnessVersion: SemverRangeSchema,
    license: z.string().min(1).max(64).optional(),
    author: z.string().min(1).max(128).optional(),
    shared: SharedBlockSchema.optional(),
    capabilities: z.array(CapabilityRefSchema).optional(),
    envSchema: z.array(EnvVarSpecSchema).optional(),
    agents: z.array(AgentEntrySchema).min(1).max(16),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Map<string, number>();
    cfg.agents.forEach((agent, idx) => {
      const first = seen.get(agent.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", idx, "id"],
          message: `duplicate agent id "${agent.id}"; first defined at index ${first}`,
        });
      } else {
        seen.set(agent.id, idx);
      }
      if (!agent.model && !cfg.shared?.model) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", idx, "model"],
          message: `agent "${agent.id}" has no model and shared.model is not set`,
        });
      }
    });
  });

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

/**
 * Union of every runtime kind declared across all agents in the bundle.
 * Used by the gallery cross-check to validate that an entry's declared
 * `runtimeKinds` matches the manifest.
 */
export function flattenRuntimeKinds(cfg: HarnessConfig): Array<RuntimeBlockInput["kind"]> {
  const kinds = new Set<RuntimeBlockInput["kind"]>();
  for (const a of cfg.agents) {
    for (const r of a.runtimes) kinds.add(r.kind);
  }
  return [...kinds];
}

/**
 * True if the agent should be registered as a task on the bundle's
 * Workflow service. An agent is a workflow task when:
 *
 *   - it has `workflowTask: true` declared explicitly, OR
 *   - any of its runtimes is `kind: workflows`, OR
 *   - any of its cron runtimes is `via: workflow`.
 *
 * The emitter uses this to compute the bundle-wide set of tasks that
 * the (single) Workflow service registers. The scaffolder uses it to
 * decide whether to emit `src/workflows.ts` and the per-cron-trigger
 * entries.
 */
export function isWorkflowTaskAgent(agent: AgentEntryInput): boolean {
  if (agent.workflowTask === true) return true;
  for (const rt of agent.runtimes) {
    if (rt.kind === "workflows") return true;
    if (rt.kind === "cron" && rt.via === "workflow") return true;
  }
  return false;
}

/**
 * Returns every workflow-task agent in the bundle, in declaration order.
 * Convenience wrapper over {@link isWorkflowTaskAgent}.
 */
export function workflowTaskAgents(cfg: HarnessConfig): AgentEntryInput[] {
  return cfg.agents.filter(isWorkflowTaskAgent);
}

// ----------------------------------------------------------------------
// index.json schema (for the central registry index repo)
// ----------------------------------------------------------------------

export const IndexEntrySchema = z
  .object({
    name: slugSchema,
    description: z.string().min(1).max(280),
    repo: z
      .string()
      .url()
      .regex(/^https?:\/\//, "repo must be an https URL"),
    /** 40-char lowercase commit SHA. Tags are rejected. */
    ref: sha40Schema,
    categories: z.array(slugSchema).max(20).optional(),
  })
  .strict();

export type IndexEntry = z.infer<typeof IndexEntrySchema>;

export const IndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(IndexEntrySchema).superRefine((entries, ctx) => {
      const seen = new Map<string, number>();
      for (let i = 0; i < entries.length; i += 1) {
        const e = entries[i];
        if (!e) continue;
        if (seen.has(e.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "name"],
            message: `duplicate entry name "${e.name}"; first seen at index ${seen.get(e.name)}`,
          });
        } else {
          seen.set(e.name, i);
        }
      }
    }),
  })
  .strict();

export type IndexFile = z.infer<typeof IndexSchema>;

// ----------------------------------------------------------------------
// Parsing helpers
// ----------------------------------------------------------------------

/**
 * Parse a YAML or JSON string into a validated {@link HarnessConfig}.
 * Throws `ZodError` with a flat list of issues on failure.
 */
export function parseHarnessConfigYaml(yamlText: string): HarnessConfig {
  const raw = parseYaml(yamlText);
  return HarnessConfigSchema.parse(raw);
}

/**
 * Parse a JSON string into a validated {@link IndexFile}.
 */
export function parseIndexJson(jsonText: string): IndexFile {
  const raw = JSON.parse(jsonText);
  return IndexSchema.parse(raw);
}
