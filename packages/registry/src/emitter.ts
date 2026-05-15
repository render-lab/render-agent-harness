/**
 * Blueprint emitter: render-harness.yaml + capability-pack contributions
 * → render.yaml.
 *
 * Authors run this once via `npx render-harness-build` and commit the
 * generated `render.yaml`. End users never run it; they just click the
 * Deploy-to-Render badge that points at the committed Blueprint.
 *
 * The emitter mirrors the shapes of the existing hand-authored
 * Blueprints in this repo:
 *
 *   blueprints/render.demo.yaml       -> single web service + Postgres
 *   blueprints/render.demo-cron.yaml  -> single cron + Postgres
 *   blueprints/render.private.yaml    -> public web + worker pserv +
 *                                        Postgres + Key Value
 *
 * Auto-derivation rule (V2 multi-agent — V1 manifests are normalized
 * via `normalizeToV2` and fall through the same path):
 *   - all agents with kind:web                  → coalesce into ONE web
 *                                                 service. If any agent
 *                                                 also has kind:worker
 *                                                 anywhere in the bundle,
 *                                                 emit the multi-tenant
 *                                                 web shell + worker pserv
 *                                                 + Key Value shape;
 *                                                 otherwise emit a single
 *                                                 sync web (runtime-web).
 *   - all agents with kind:worker               → coalesce into ONE worker
 *                                                 pserv. Implies Key Value.
 *   - each kind:cron runtime entry across all   → ONE Render Cron service
 *     agents                                      per entry, named
 *                                                 `<bundle>-cron-<agentId>`
 *                                                 (single-agent bundles
 *                                                 preserve the V1 name).
 *                                                 `HARNESS_AGENT_ID` env
 *                                                 var selects the agent at
 *                                                 boot.
 *   - each kind:workflows runtime entry          → one Dashboard checklist
 *                                                 step per agent.
 */

import { stringify as stringifyYaml } from "yaml";
import {
  type CapabilityPack,
  namespacedMcpServerName,
  namespacedToolName,
  type RenderServiceSpec,
} from "./capability.js";
import type { LoadedPack } from "./load-pack.js";
import { makePackContext } from "./load-pack.js";
import {
  type AgentEntryInput,
  type EnvVarSpec,
  type HarnessConfig,
  type ModelSpecInput,
  type RuntimeBlockInput,
  workflowTaskAgents,
} from "./schema.js";

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

export interface EmitOpts {
  config: HarnessConfig;
  /** Loaded packs (already validated). */
  packs?: LoadedPack[];
  /**
   * Env source used for any pack `renderServices` callback. Defaults
   * to `process.env`, but can be overridden in tests.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the inferred entry-package script name. The build commands
   * in the emitted Blueprint reference `pnpm --filter <packageName>
   * build`. Defaults to a synthesized name matching the existing
   * examples convention: `@render-harness/example-${entry.name}`.
   */
  packageName?: string;
  /**
   * Override the default Render region. Defaults to "oregon" to match
   * the existing hand-authored Blueprints.
   */
  region?: string;
  /**
   * Output mode. Controls which Blueprint shape the emitter targets.
   *
   *   - "default" — the normal shape, matches `blueprints/render.demo.yaml`,
   *     `render.demo-cron.yaml`, and `render.private.yaml`.
   *   - "hardened" — Phase 5 shape (egress allowlist, private MCP pservs,
   *     audit trail). Currently behaves identically to "default" — Phase
   *     5 plugs into this hook by extending the service builders to add
   *     hardened-mode env vars and replacing the public surface with
   *     IAP-fronted entrypoints.
   */
  mode?: "default" | "hardened";
}

export interface EmitResult {
  /** The serialized render.yaml. */
  yaml: string;
  /** The structured Blueprint object (handy for tests / inspection). */
  blueprint: Blueprint;
  /** Any Dashboard-only steps (Workflows services live outside Blueprints). */
  dashboardSteps: string[];
  /** The merged effective envSchema (entry + packs), used by the Deploy badge. */
  effectiveEnvSchema: EnvVarSpec[];
  /** Warnings to surface in the build CLI output. */
  warnings: string[];
}

export async function emitBlueprint(opts: EmitOpts): Promise<EmitResult> {
  const env = opts.env ?? process.env;
  const region = opts.region ?? "oregon";
  const mode = opts.mode ?? "default";
  const cfg = opts.config;
  const packageName = opts.packageName ?? `@render-harness/example-${cfg.name}`;
  const warnings: string[] = [];
  const dashboardSteps: string[] = [];

  if (mode === "hardened") {
    warnings.push(
      "hardened mode is not yet supported by render-harness-build (Phase 5). Falling back to the default Blueprint shape.",
    );
  }

  // Group agents/runtimes by kind across the whole bundle.
  const buckets = bucketByKind(cfg);
  const isMultiTenantWeb = buckets.web.length > 0 && buckets.worker.length > 0;
  const needsKv = buckets.worker.length > 0 || (opts.packs ?? []).some((p) => packNeedsKv(p));
  const naming = buildNaming(cfg);

  // -------------- databases + key value --------------------------------
  const databases: BlueprintDatabase[] = [
    {
      name: dbName(cfg),
      plan: "basic-256mb",
      region,
      postgresMajorVersion: "17",
    },
  ];

  const services: BlueprintService[] = [];

  if (needsKv) {
    services.push({
      type: "keyvalue",
      name: kvName(cfg),
      plan: "free",
      region,
      ipAllowList: [],
    });
  }

  // -------------- coalesced web service -------------------------------
  if (buckets.web.length > 0) {
    // Pick the first declared web runtime for plan/region/healthCheckPath.
    // If multiple web agents specify divergent fields the first wins;
    // surface a warning so the user knows the conflict was ignored.
    const primary = buckets.web[0];
    if (!primary) throw new Error("unreachable: web bucket non-empty");
    if (buckets.web.length > 1) {
      const divergent = buckets.web
        .slice(1)
        .filter(
          ({ rt }) =>
            (rt.plan && rt.plan !== primary.rt.plan) ||
            (rt.region && rt.region !== primary.rt.region) ||
            (rt.healthCheckPath && rt.healthCheckPath !== primary.rt.healthCheckPath),
        );
      if (divergent.length > 0) {
        warnings.push(
          `Multiple agents declare kind:web with divergent plan/region/healthCheckPath. Using the first (agent "${primary.agent.id}"); others ignored.`,
        );
      }
    }
    if (isMultiTenantWeb) {
      services.push(
        webShellService({
          cfg: cfg,
          rt: primary.rt,
          packageName,
          region,
          naming,
        }),
      );
    } else {
      services.push(
        syncWebService({
          cfg: cfg,
          agent: primary.agent,
          rt: primary.rt,
          packageName,
          region,
          naming,
        }),
      );
    }
  }

  // -------------- coalesced worker pserv ------------------------------
  if (buckets.worker.length > 0) {
    const primary = buckets.worker[0];
    if (!primary) throw new Error("unreachable: worker bucket non-empty");
    // Worker queue: if multiple workers explicitly declared divergent
    // queue names, that's a v3 concern — flag it and use the first.
    const divergentQueues = buckets.worker
      .slice(1)
      .filter(({ rt }) => rt.queue && rt.queue !== primary.rt.queue);
    if (divergentQueues.length > 0) {
      warnings.push(
        `Multiple agents declare kind:worker with divergent queue names. Using "${primary.rt.queue ?? workerQueue(cfg)}"; per-agent queues are not supported in v1.`,
      );
    }
    services.push(
      workerService({
        cfg: cfg,
        rt: primary.rt,
        packageName,
        region,
        naming,
      }),
    );
  }

  // -------------- one cron service per cron runtime entry -------------
  // Split by `via`: default ("cron") emits the agent-inline cron service;
  // "workflow" emits a thin trigger that calls render.workflows.runTask.
  const workflowSlug = workflowServiceSlug(cfg);
  for (const { agent, rt } of buckets.cron) {
    if (rt.via === "workflow") {
      services.push(
        cronTriggerService({
          cfg: cfg,
          agent,
          rt,
          packageName,
          region,
          naming,
          workflowSlug,
        }),
      );
    } else {
      services.push(
        cronService({
          cfg: cfg,
          agent,
          rt,
          packageName,
          region,
          naming,
        }),
      );
    }
  }

  // -------------- workflow tasks: one Dashboard checklist line --------
  // Every workflow-mode agent (explicit workflowTask: true, kind: workflows
  // runtime, OR a cron with via: workflow) is hosted as one task on the
  // bundle's single Workflow service. Render allows up to 500 tasks per
  // service, so one service is enough.
  const wfAgents = workflowTaskAgents(cfg);
  if (wfAgents.length > 0) {
    const taskList = wfAgents.map((a) => `\`${a.id}\``).join(", ");
    dashboardSteps.push(
      `Create one Render Workflow service named \`${workflowSlug}\`, link this repo, set the build command to \`pnpm install --frozen-lockfile && pnpm --filter ${packageName} build\` and the start command to \`node examples/${cfg.name}/dist/workflows.js\`. It will host these tasks: ${taskList}.`,
    );
    warnings.push(
      "Render Workflows aren't yet supported in render.yaml. The emitted Blueprint omits the Workflow service; create it from the Render Dashboard following the checklist step above.",
    );
  }

  // -------------- pack-contributed services ---------------------------
  for (const loaded of opts.packs ?? []) {
    if (!loaded.pack.renderServices) continue;
    const ctx = makePackContext(loaded, cfg.name, env);
    const extras = await loaded.pack.renderServices(ctx);
    for (const spec of extras) {
      services.push(translatePackService(spec, loaded.pack.name, region));
    }
  }

  // -------------- effective envSchema --------------------------------
  const effectiveEnvSchema = mergeEnvSchemas(cfg, opts.packs ?? []);

  const envVarGroups = buildEnvVarGroups(cfg);
  const blueprint: Blueprint = {
    databases,
    services: expandSharedEnvGroup(services, envVarGroups),
    projects: [
      {
        name: cfg.name,
        environments: [
          {
            name: "production",
            databases,
            services: attachSharedEnvGroup(services, envVarGroups),
            ...(envVarGroups.length > 0 ? { envVarGroups } : {}),
          },
        ],
      },
    ],
  };
  const yaml = serializeBlueprint(blueprint);

  return { yaml, blueprint, dashboardSteps, effectiveEnvSchema, warnings };
}

// ----------------------------------------------------------------------
// Bundle bucketing
// ----------------------------------------------------------------------

type WebRt = Extract<RuntimeBlockInput, { kind: "web" }>;
type WorkerRt = Extract<RuntimeBlockInput, { kind: "worker" }>;
type CronRt = Extract<RuntimeBlockInput, { kind: "cron" }>;
type WorkflowsRt = Extract<RuntimeBlockInput, { kind: "workflows" }>;

interface Buckets {
  web: Array<{ agent: AgentEntryInput; rt: WebRt }>;
  worker: Array<{ agent: AgentEntryInput; rt: WorkerRt }>;
  cron: Array<{ agent: AgentEntryInput; rt: CronRt }>;
  workflows: Array<{ agent: AgentEntryInput; rt: WorkflowsRt }>;
}

function bucketByKind(cfg: HarnessConfig): Buckets {
  const buckets: Buckets = { web: [], worker: [], cron: [], workflows: [] };
  for (const agent of cfg.agents) {
    for (const rt of agent.runtimes) {
      switch (rt.kind) {
        case "web":
          buckets.web.push({ agent, rt });
          break;
        case "worker":
          buckets.worker.push({ agent, rt });
          break;
        case "cron":
          buckets.cron.push({ agent, rt });
          break;
        case "workflows":
          buckets.workflows.push({ agent, rt });
          break;
      }
    }
  }
  return buckets;
}

// ----------------------------------------------------------------------
// Naming
//
// Single-agent bundles (one agent whose id matches the bundle name)
// preserve V1-era naming — this is the form `normalizeToV2` produces
// from a V1 manifest, so every existing render.yaml stays identical.
// Multi-agent bundles disambiguate cron services with `<bundle>-cron-
// <agentId>` and use the bundle name as the prefix for everything else.
// ----------------------------------------------------------------------

interface Naming {
  /** True when the bundle has exactly one agent whose id matches the bundle name. */
  singleAgent: boolean;
  cron(agentId: string): string;
  cronTrigger(agentId: string): string;
  syncWebStartCommand(): string;
  webShellStartCommand(): string;
  workerStartCommand(): string;
  cronStartCommand(agentId: string): string;
  cronTriggerStartCommand(): string;
}

function buildNaming(cfg: HarnessConfig): Naming {
  const singleAgent = cfg.agents.length === 1 && cfg.agents[0]?.id === cfg.name;
  return {
    singleAgent,
    cron(agentId) {
      if (singleAgent) return cfg.name;
      return `${cfg.name}-cron-${agentId}`;
    },
    cronTrigger(agentId) {
      // Trigger services always carry an `-cron-trigger-<agentId>` suffix
      // (even in single-agent bundles) to disambiguate from inline crons
      // and from the workflow service slug.
      return `${cfg.name}-cron-trigger-${agentId}`;
    },
    syncWebStartCommand() {
      return `node packages/${cfg.name}/dist/main.js`;
    },
    webShellStartCommand() {
      return `node examples/${cfg.name}/dist/web.js`;
    },
    workerStartCommand() {
      return `node examples/${cfg.name}/dist/worker.js`;
    },
    cronStartCommand(_agentId) {
      // Single-agent bundles still ship a `dist/main.js` entrypoint
      // (existing convention). Multi-agent bundles ship `dist/cron.js`
      // that selects the agent via HARNESS_AGENT_ID.
      if (singleAgent) return `node examples/${cfg.name}/dist/main.js`;
      return `node examples/${cfg.name}/dist/cron.js`;
    },
    cronTriggerStartCommand() {
      return `node examples/${cfg.name}/dist/cron-trigger.js`;
    },
  };
}

/**
 * Stable slug for the bundle's single Workflow service. Today the emitter
 * surfaces this in the Dashboard checklist and on cron-trigger services'
 * `WORKFLOW_SLUG` env var; a future `render-harness workflows sync` CLI
 * will use it to create/update the Workflow service via the Render API.
 */
function workflowServiceSlug(cfg: HarnessConfig): string {
  return `${cfg.name}-workflows`;
}

// ----------------------------------------------------------------------
// Service builders
// ----------------------------------------------------------------------

interface WebShellArgs {
  cfg: HarnessConfig;
  rt: WebRt;
  packageName: string;
  region: string;
  naming: Naming;
}

interface SyncWebArgs extends WebShellArgs {
  agent: AgentEntryInput;
}

interface WorkerArgs {
  cfg: HarnessConfig;
  rt: WorkerRt;
  packageName: string;
  region: string;
  naming: Naming;
}

interface CronArgs {
  cfg: HarnessConfig;
  agent: AgentEntryInput;
  rt: CronRt;
  packageName: string;
  region: string;
  naming: Naming;
}

function syncWebService(args: SyncWebArgs): BlueprintService {
  const { cfg, agent, rt, packageName, region, naming } = args;
  return {
    type: "web",
    name: cfg.name,
    runtime: "node",
    region: rt.region ?? region,
    plan: rt.plan ?? "starter",
    rootDir: ".",
    buildCommand: defaultBuildCommand(packageName),
    startCommand: naming.syncWebStartCommand(),
    healthCheckPath: rt.healthCheckPath ?? "/healthz",
    envVars: [
      ...sharedRuntimeEnv(cfg),
      ...modelEnv(effectiveModel(cfg, agent)),
      ...workflowEnvIfNeeded(cfg),
      ...explicitEntryEnv(cfg),
    ],
  };
}

function webShellService(args: WebShellArgs): BlueprintService {
  const { cfg, rt, packageName, region, naming } = args;
  return {
    type: "web",
    name: `${cfg.name}-web`,
    runtime: "node",
    region: rt.region ?? region,
    plan: rt.plan ?? "starter",
    rootDir: ".",
    buildCommand: defaultBuildCommand(packageName),
    startCommand: naming.webShellStartCommand(),
    healthCheckPath: rt.healthCheckPath ?? "/healthz",
    envVars: [
      { key: "WORKER_QUEUE", value: workerQueue(cfg) },
      ...sharedRuntimeEnv(cfg),
      ...kvFromService(cfg),
      ...workflowEnvIfNeeded(cfg),
      ...explicitEntryEnv(cfg),
    ],
  };
}

function workerService(args: WorkerArgs): BlueprintService {
  const { cfg, rt, packageName, region, naming } = args;
  return {
    type: "pserv",
    name: `${cfg.name}-worker`,
    runtime: "node",
    region: rt.region ?? region,
    plan: rt.plan ?? "starter",
    rootDir: ".",
    buildCommand: defaultBuildCommand(packageName),
    startCommand: naming.workerStartCommand(),
    envVars: [
      { key: "WORKER_QUEUE", value: rt.queue ?? workerQueue(cfg) },
      ...sharedRuntimeEnv(cfg),
      // Worker is multi-tenant — it carries every agent's model envs;
      // use the bundle default (shared.model) here.
      ...modelEnv(requireSharedModel(cfg)),
      ...kvFromService(cfg),
      ...workflowEnvIfNeeded(cfg),
      ...explicitEntryEnv(cfg),
    ],
  };
}

/**
 * Wires `WORKFLOW_SLUG` + `RENDER_API_KEY` into a runtime service's env
 * when the bundle has any workflow-task agent. Required for the
 * `trigger_workflow` builtin to register inside that service. Returns
 * an empty array for bundles with no workflow-task agents — no point
 * shipping a sync:false env var the user has to fill in for nothing.
 */
function workflowEnvIfNeeded(cfg: HarnessConfig): BlueprintEnvVar[] {
  if (workflowTaskAgents(cfg).length === 0) return [];
  return [
    { key: "WORKFLOW_SLUG", value: workflowServiceSlug(cfg) },
    { key: "RENDER_API_KEY", sync: false },
  ];
}

function cronService(args: CronArgs): BlueprintService {
  const { cfg, agent, rt, packageName, region, naming } = args;
  const envVars: BlueprintEnvVar[] = [
    ...sharedRuntimeEnv(cfg),
    ...modelEnv(effectiveModel(cfg, agent)),
    ...explicitEntryEnv(cfg),
  ];
  if (!naming.singleAgent) {
    envVars.unshift({ key: "HARNESS_AGENT_ID", value: agent.id });
  }
  return {
    type: "cron",
    name: naming.cron(agent.id),
    runtime: "node",
    region: rt.region ?? region,
    plan: rt.plan ?? "starter",
    schedule: rt.schedule,
    rootDir: ".",
    buildCommand: defaultBuildCommand(packageName),
    startCommand: naming.cronStartCommand(agent.id),
    envVars,
  };
}

interface CronTriggerArgs extends CronArgs {
  workflowSlug: string;
}

/**
 * Thin Cron service whose only job is to call
 * `render.workflows.runTask("<workflowSlug>/<agentId>", [])` via the
 * Render SDK and exit. The actual agent run executes in the bundle's
 * Workflow service. Used for `kind: cron, via: workflow` runtime
 * entries.
 *
 * - No model env (no model inference happens here).
 * - DATABASE_URL is included so the trigger can pre-create the
 *   `agent_runs` row via `triggerAgentWorkflow` for unified observability.
 * - `RENDER_API_KEY` is sync:false (user provides at deploy time).
 * - `WORKFLOW_TASK_REF` is the literal `<workflow-slug>/<agent-id>` the
 *   trigger script reads at boot.
 */
function cronTriggerService(args: CronTriggerArgs): BlueprintService {
  const { cfg, agent, rt, packageName, region, naming, workflowSlug } = args;
  const taskRef = `${workflowSlug}/${agent.id}`;
  return {
    type: "cron",
    name: naming.cronTrigger(agent.id),
    runtime: "node",
    region: rt.region ?? region,
    plan: rt.plan ?? "starter",
    schedule: rt.schedule,
    rootDir: ".",
    buildCommand: defaultBuildCommand(packageName),
    startCommand: naming.cronTriggerStartCommand(),
    envVars: [
      { key: "HARNESS_AGENT_ID", value: agent.id },
      { key: "WORKFLOW_SLUG", value: workflowSlug },
      { key: "WORKFLOW_TASK_REF", value: taskRef },
      { key: "RENDER_API_KEY", sync: false },
      ...sharedRuntimeEnv(cfg),
      ...explicitEntryEnv(cfg),
    ],
  };
}

// ----------------------------------------------------------------------
// Pack-service translation
// ----------------------------------------------------------------------

function translatePackService(
  spec: RenderServiceSpec,
  packName: string,
  region: string,
): BlueprintService {
  const base: BlueprintService = {
    type: spec.type,
    name: spec.name,
    runtime: spec.runtime,
    region: spec.region ?? region,
    ...(spec.plan ? { plan: spec.plan } : {}),
    ...(spec.rootDir ? { rootDir: spec.rootDir } : {}),
    ...(spec.buildCommand ? { buildCommand: spec.buildCommand } : {}),
    ...(spec.startCommand ? { startCommand: spec.startCommand } : {}),
    ...(spec.dockerfilePath ? { dockerfilePath: spec.dockerfilePath } : {}),
    ...(spec.dockerContext ? { dockerContext: spec.dockerContext } : {}),
    ...(spec.envVars ? { envVars: spec.envVars.map(toBlueprintEnvVar) } : {}),
  };
  void packName;
  return base;
}

function toBlueprintEnvVar(
  input: NonNullable<RenderServiceSpec["envVars"]>[number],
): BlueprintEnvVar {
  const out: BlueprintEnvVar = { key: input.key };
  if (input.value !== undefined) out.value = input.value;
  if (input.sync === false) out.sync = false;
  if (input.fromDatabase) out.fromDatabase = input.fromDatabase;
  if (input.fromService) {
    out.fromService = {
      name: input.fromService.name,
      type: input.fromService.type,
      property: input.fromService.property,
    };
  }
  return out;
}

// ----------------------------------------------------------------------
// Shared env builders
// ----------------------------------------------------------------------

function sharedRuntimeEnv(cfg: HarnessConfig): BlueprintEnvVar[] {
  return [
    {
      key: "DATABASE_URL",
      fromDatabase: { name: dbName(cfg), property: "connectionString" },
    },
  ];
}

function modelEnv(model: ModelSpecInput): BlueprintEnvVar[] {
  const out: BlueprintEnvVar[] = [{ key: "LLM_MODEL", value: model.model }];
  if (model.provider === "openai-compat") {
    if (model.baseURL) {
      out.push({ key: "OPENAI_BASE_URL", value: model.baseURL });
    }
  }
  return out;
}

function kvFromService(cfg: HarnessConfig): BlueprintEnvVar[] {
  return [
    {
      key: "KV_URL",
      fromService: {
        name: kvName(cfg),
        type: "keyvalue",
        property: "connectionString",
      },
    },
  ];
}

function explicitEntryEnv(cfg: HarnessConfig): BlueprintEnvVar[] {
  void cfg;
  return [];
}

function buildEnvVarGroups(cfg: HarnessConfig): BlueprintEnvVarGroup[] {
  const vars = new Map<string, BlueprintEnvVar>();
  const add = (envVar: BlueprintEnvVar) => {
    if (canLiveInEnvGroup(envVar) && envVar.key) vars.set(envVar.key, envVar);
  };

  add({ key: "NODE_ENV", value: "production" });
  add({ key: "LOG_LEVEL", value: "info" });

  for (const model of collectModels(cfg)) {
    if (model.provider === "anthropic") add({ key: "ANTHROPIC_API_KEY", sync: false });
    if (model.provider === "openai-compat") {
      add({ key: "OPENAI_API_KEY", sync: false });
    }
  }

  for (const spec of cfg.envSchema ?? []) {
    const envVar: BlueprintEnvVar = { key: spec.name };
    if (spec.secret) {
      envVar.sync = false;
    } else if (spec.default !== undefined) {
      envVar.value = spec.default;
    } else {
      envVar.sync = false;
    }
    add(envVar);
  }

  return vars.size > 0 ? [{ name: envGroupName(cfg), envVars: [...vars.values()] }] : [];
}

function canLiveInEnvGroup(envVar: BlueprintEnvVar): boolean {
  return !envVar.fromDatabase && !envVar.fromService && !envVar.fromGroup;
}

function attachSharedEnvGroup(
  services: BlueprintService[],
  envVarGroups: BlueprintEnvVarGroup[],
): BlueprintService[] {
  if (envVarGroups.length === 0) return services;
  const group = envVarGroups[0];
  if (!group) return services;
  return services.map((service) => {
    if (!serviceSupportsEnvVars(service)) return service;
    return {
      ...service,
      envVars: [{ fromGroup: group.name }, ...(service.envVars ?? [])],
    };
  });
}

function expandSharedEnvGroup(
  services: BlueprintService[],
  envVarGroups: BlueprintEnvVarGroup[],
): BlueprintService[] {
  const groupVars = envVarGroups.flatMap((group) => group.envVars);
  if (groupVars.length === 0) return services;
  return services.map((service) => {
    if (!serviceSupportsEnvVars(service)) return service;
    return {
      ...service,
      envVars: [...(service.envVars ?? []), ...groupVars],
    };
  });
}

function serviceSupportsEnvVars(service: BlueprintService): boolean {
  return service.type !== "keyvalue";
}

// ----------------------------------------------------------------------
// Effective envSchema (entry + packs)
// ----------------------------------------------------------------------

function mergeEnvSchemas(cfg: HarnessConfig, packs: LoadedPack[]): EnvVarSpec[] {
  const seen = new Map<string, EnvVarSpec>();
  for (const spec of cfg.envSchema ?? []) seen.set(spec.name, spec);
  for (const loaded of packs) {
    for (const spec of loaded.pack.envSchema ?? []) {
      if (!seen.has(spec.name)) seen.set(spec.name, spec);
    }
  }
  // Always add api keys for every model provider actually referenced —
  // bundle default + any per-agent overrides.
  const providers = collectProviders(cfg);
  if (providers.has("anthropic") && !seen.has("ANTHROPIC_API_KEY")) {
    seen.set("ANTHROPIC_API_KEY", {
      name: "ANTHROPIC_API_KEY",
      required: true,
      secret: true,
      description: "Anthropic API key for the agent's model.",
    });
  }
  if (providers.has("openai-compat") && !seen.has("OPENAI_API_KEY")) {
    seen.set("OPENAI_API_KEY", {
      name: "OPENAI_API_KEY",
      required: true,
      secret: true,
      description: "OpenAI-compatible API key for the agent's model.",
    });
  }
  return [...seen.values()];
}

function collectProviders(cfg: HarnessConfig): Set<ModelSpecInput["provider"]> {
  const set = new Set<ModelSpecInput["provider"]>();
  if (cfg.shared?.model) set.add(cfg.shared.model.provider);
  for (const a of cfg.agents) {
    if (a.model) set.add(a.model.provider);
  }
  return set;
}

function collectModels(cfg: HarnessConfig): ModelSpecInput[] {
  const out: ModelSpecInput[] = [];
  if (cfg.shared?.model) out.push(cfg.shared.model);
  for (const a of cfg.agents) {
    if (a.model) out.push(a.model);
  }
  return out;
}

function packNeedsKv(loaded: LoadedPack): boolean {
  void loaded;
  return false;
}

// ----------------------------------------------------------------------
// Model resolution
// ----------------------------------------------------------------------

function effectiveModel(cfg: HarnessConfig, agent: AgentEntryInput): ModelSpecInput {
  if (agent.model) return agent.model;
  if (cfg.shared?.model) return cfg.shared.model;
  throw new Error(
    `agent "${agent.id}" has no model and shared.model is unset (schema should have rejected this)`,
  );
}

function requireSharedModel(cfg: HarnessConfig): ModelSpecInput {
  if (cfg.shared?.model) return cfg.shared.model;
  // Fallback for bundles where every agent has a per-agent model. Pick
  // the first agent's model — the worker process can dispatch to any
  // agent at runtime, but the env vars wired here are for the *default*
  // model. Per-agent providers still get their API keys via the merged
  // envSchema, which collects every referenced provider.
  const first = cfg.agents[0]?.model;
  if (first) return first;
  throw new Error("no model configured at bundle or agent level");
}

// ----------------------------------------------------------------------
// Naming helpers
// ----------------------------------------------------------------------

function dbName(cfg: HarnessConfig): string {
  return `${cfg.name}-db`;
}

function kvName(cfg: HarnessConfig): string {
  return `${cfg.name}-kv`;
}

function workerQueue(cfg: HarnessConfig): string {
  return `${cfg.name}-runs`;
}

function envGroupName(cfg: HarnessConfig): string {
  return `${cfg.name}-env`;
}

function defaultBuildCommand(packageName: string): string {
  return `pnpm install --frozen-lockfile && pnpm --filter ${packageName} build`;
}

// ----------------------------------------------------------------------
// Render Blueprint shape
// ----------------------------------------------------------------------

export interface Blueprint {
  databases?: BlueprintDatabase[];
  services?: BlueprintService[];
  projects?: BlueprintProject[];
  envVarGroups?: BlueprintEnvVarGroup[];
}

export interface BlueprintDatabase {
  name: string;
  plan: string;
  region?: string;
  postgresMajorVersion?: string;
}

export interface BlueprintEnvVar {
  key?: string;
  value?: string;
  sync?: false;
  fromDatabase?: { name: string; property: string };
  fromService?: { name: string; type: string; property: string };
  fromGroup?: string;
}

export interface BlueprintEnvVarGroup {
  name: string;
  envVars: BlueprintEnvVar[];
}

export interface BlueprintProject {
  name: string;
  environments: BlueprintEnvironment[];
}

export interface BlueprintEnvironment {
  name: string;
  databases?: BlueprintDatabase[];
  services?: BlueprintService[];
  envVarGroups?: BlueprintEnvVarGroup[];
}

export interface BlueprintService {
  type: "web" | "worker" | "pserv" | "cron" | "keyvalue";
  name: string;
  runtime?: "node" | "docker" | "image";
  region?: string;
  plan?: string;
  schedule?: string;
  rootDir?: string;
  buildCommand?: string;
  startCommand?: string;
  healthCheckPath?: string;
  dockerfilePath?: string;
  dockerContext?: string;
  envVars?: BlueprintEnvVar[];
  ipAllowList?: string[];
}

// ----------------------------------------------------------------------
// Serialization
// ----------------------------------------------------------------------

const HEADER = `# yaml-language-server: $schema=https://render.com/schema/render.yaml.json
#
# Generated by \`render-harness-build\` from render-harness.yaml.
# Do not edit by hand — re-run the build to regenerate.
`;

function serializeBlueprint(bp: Blueprint): string {
  const bodyShape: Blueprint =
    bp.projects && bp.projects.length > 0 ? { projects: bp.projects } : bp;
  const body = stringifyYaml(bodyShape, {
    lineWidth: 100,
    minContentWidth: 40,
    aliasDuplicateObjects: false,
  });
  return `${HEADER}\n${body}`;
}

// Touch references to pack helpers so the export surface keeps them
// reachable for capability authors who import the emitter for tests.
void namespacedToolName;
void namespacedMcpServerName;
void ((_p: CapabilityPack) => {});
