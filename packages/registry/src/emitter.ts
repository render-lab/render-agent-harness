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
 * Auto-derivation rule:
 *   - kind:web alone     → emit a single web service (runtime-web shape).
 *   - kind:web + worker  → emit packages/web (multi-tenant) + worker
 *                          pserv. Implies Key Value.
 *   - kind:cron alone    → emit a cron service.
 *   - kind:workflows     → not Blueprintable; emit a Dashboard checklist.
 */

import { stringify as stringifyYaml } from "yaml";
import {
  type CapabilityPack,
  type RenderServiceSpec,
  namespacedMcpServerName,
  namespacedToolName,
} from "./capability.js";
import type { LoadedPack } from "./load-pack.js";
import { makePackContext } from "./load-pack.js";
import type { EnvVarSpec, HarnessConfig } from "./schema.js";

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
   *     IAP-fronted entrypoints. Tracked in the harness-config-registry
   *     plan's `phase5_alignment` todo.
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
  const packageName = opts.packageName ?? `@render-harness/example-${opts.config.name}`;
  const warnings: string[] = [];
  const dashboardSteps: string[] = [];

  if (mode === "hardened") {
    // Phase 5 hook: hardened-mode handling lands here. Until it ships,
    // emit the default shape with a one-line note in the result so users
    // know they asked for hardened mode but didn't get it.
    warnings.push(
      "hardened mode is not yet supported by render-harness-build (Phase 5). Falling back to the default Blueprint shape.",
    );
  }

  const kinds = new Set(opts.config.runtimes.map((r) => r.kind));
  const isMultiTenantWeb = kinds.has("web") && kinds.has("worker");
  const needsKv = kinds.has("worker") || (opts.packs ?? []).some((p) => packNeedsKv(p));

  // -------------- databases + key value --------------------------------
  const databases: BlueprintDatabase[] = [
    {
      name: dbName(opts.config),
      plan: "basic-256mb",
      region,
      postgresMajorVersion: "17",
    },
  ];

  const services: BlueprintService[] = [];

  if (needsKv) {
    services.push({
      type: "keyvalue",
      name: kvName(opts.config),
      plan: "free",
      region,
      ipAllowList: [],
    });
  }

  // -------------- runtime services -------------------------------------
  for (const rt of opts.config.runtimes) {
    if (rt.kind === "workflows") {
      // Workflows can't be Blueprinted yet; record a Dashboard step.
      dashboardSteps.push(
        `Create a Render Workflow service from this repo. Build command: \`corepack enable && pnpm install --frozen-lockfile && pnpm --filter ${packageName} build\`. Start command depends on the entry; see the entry's README. Plan: ${rt.plan ?? "starter"}.`,
      );
      continue;
    }

    if (rt.kind === "cron") {
      services.push(
        cronService({
          config: opts.config,
          rt,
          packageName,
          region,
        }),
      );
      continue;
    }

    if (rt.kind === "web") {
      if (isMultiTenantWeb) {
        // Public web shell that fronts runtime-worker (packages/web).
        services.push(webShellService({ config: opts.config, rt, packageName, region }));
      } else {
        // Single-process synchronous web (runtime-web).
        services.push(syncWebService({ config: opts.config, rt, packageName, region }));
      }
      continue;
    }

    if (rt.kind === "worker") {
      services.push(workerService({ config: opts.config, rt, packageName, region }));
      continue;
    }
  }

  // -------------- pack-contributed services ----------------------------
  for (const loaded of opts.packs ?? []) {
    if (!loaded.pack.renderServices) continue;
    const ctx = makePackContext(loaded, opts.config.name, env);
    const extras = await loaded.pack.renderServices(ctx);
    for (const spec of extras) {
      services.push(translatePackService(spec, loaded.pack.name, region));
    }
  }

  // -------------- effective envSchema ----------------------------------
  const effectiveEnvSchema = mergeEnvSchemas(opts.config, opts.packs ?? []);

  const blueprint: Blueprint = { databases, services };
  const yaml = serializeBlueprint(blueprint);

  if (kinds.has("workflows")) {
    warnings.push(
      "Render Workflows aren't yet supported in render.yaml. The emitted Blueprint omits the Workflow service; deploy it from the Render Dashboard following the steps in the README.",
    );
  }

  return { yaml, blueprint, dashboardSteps, effectiveEnvSchema, warnings };
}

// ----------------------------------------------------------------------
// Service builders
// ----------------------------------------------------------------------

interface ServiceBuilderArgs<R> {
  config: HarnessConfig;
  rt: R;
  packageName: string;
  region: string;
}

type WebRt = Extract<HarnessConfig["runtimes"][number], { kind: "web" }>;
type WorkerRt = Extract<HarnessConfig["runtimes"][number], { kind: "worker" }>;
type CronRt = Extract<HarnessConfig["runtimes"][number], { kind: "cron" }>;

function syncWebService(args: ServiceBuilderArgs<WebRt>): BlueprintService {
  const { config, rt, packageName, region } = args;
  return {
    type: "web",
    name: config.name,
    runtime: "node",
    region: rt.region ?? region,
    plan: rt.plan ?? "starter",
    rootDir: ".",
    buildCommand: defaultBuildCommand(packageName),
    startCommand: `node packages/${config.name}/dist/main.js`,
    healthCheckPath: rt.healthCheckPath ?? "/healthz",
    envVars: [
      ...sharedRuntimeEnv(config),
      ...modelEnv(config),
      ...explicitEntryEnv(config),
    ],
  };
}

function webShellService(args: ServiceBuilderArgs<WebRt>): BlueprintService {
  const { config, rt, packageName, region } = args;
  return {
    type: "web",
    name: `${config.name}-web`,
    runtime: "node",
    region: rt.region ?? region,
    plan: rt.plan ?? "starter",
    rootDir: ".",
    buildCommand: defaultBuildCommand(packageName),
    startCommand: `node examples/${config.name}/dist/web.js`,
    healthCheckPath: rt.healthCheckPath ?? "/healthz",
    envVars: [
      { key: "WORKER_QUEUE", value: workerQueue(config) },
      ...sharedRuntimeEnv(config),
      ...kvFromService(config),
      ...explicitEntryEnv(config),
    ],
  };
}

function workerService(args: ServiceBuilderArgs<WorkerRt>): BlueprintService {
  const { config, rt, packageName, region } = args;
  return {
    type: "pserv",
    name: `${config.name}-worker`,
    runtime: "node",
    region: rt.region ?? region,
    plan: rt.plan ?? "starter",
    rootDir: ".",
    buildCommand: defaultBuildCommand(packageName),
    startCommand: `node examples/${config.name}/dist/worker.js`,
    envVars: [
      { key: "WORKER_QUEUE", value: rt.queue ?? workerQueue(config) },
      ...sharedRuntimeEnv(config),
      ...modelEnv(config),
      ...kvFromService(config),
      ...explicitEntryEnv(config),
    ],
  };
}

function cronService(args: ServiceBuilderArgs<CronRt>): BlueprintService {
  const { config, rt, packageName, region } = args;
  return {
    type: "cron",
    name: config.name,
    runtime: "node",
    region: rt.region ?? region,
    plan: rt.plan ?? "starter",
    schedule: rt.schedule,
    rootDir: ".",
    buildCommand: defaultBuildCommand(packageName),
    startCommand: `node examples/${config.name}/dist/main.js`,
    envVars: [
      ...sharedRuntimeEnv(config),
      ...modelEnv(config),
      ...explicitEntryEnv(config),
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
  // The contributing pack's name isn't surfaced in the YAML itself
  // (render.yaml has no comment field on services). Authors can
  // inspect the build output if they need to trace.
  void packName;
  return base;
}

function toBlueprintEnvVar(input: NonNullable<RenderServiceSpec["envVars"]>[number]): BlueprintEnvVar {
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

function sharedRuntimeEnv(config: HarnessConfig): BlueprintEnvVar[] {
  return [
    { key: "NODE_ENV", value: "production" },
    { key: "LOG_LEVEL", value: "info" },
    {
      key: "DATABASE_URL",
      fromDatabase: { name: dbName(config), property: "connectionString" },
    },
  ];
}

function modelEnv(config: HarnessConfig): BlueprintEnvVar[] {
  const out: BlueprintEnvVar[] = [
    { key: "LLM_MODEL", value: config.model.model },
  ];
  if (config.model.provider === "anthropic") {
    out.push({ key: "ANTHROPIC_API_KEY", sync: false });
  } else if (config.model.provider === "openai-compat") {
    out.push({ key: "OPENAI_API_KEY", sync: false });
    if (config.model.baseURL) {
      out.push({ key: "OPENAI_BASE_URL", value: config.model.baseURL });
    }
  }
  return out;
}

function kvFromService(config: HarnessConfig): BlueprintEnvVar[] {
  return [
    {
      key: "KV_URL",
      fromService: {
        name: kvName(config),
        type: "keyvalue",
        property: "connectionString",
      },
    },
  ];
}

function explicitEntryEnv(config: HarnessConfig): BlueprintEnvVar[] {
  if (!config.envSchema?.length) return [];
  return config.envSchema.map((spec) => {
    const envVar: BlueprintEnvVar = { key: spec.name };
    if (spec.secret) {
      envVar.sync = false;
    } else if (spec.default !== undefined) {
      envVar.value = spec.default;
    } else {
      envVar.sync = false;
    }
    return envVar;
  });
}

// ----------------------------------------------------------------------
// Effective envSchema (entry + packs)
// ----------------------------------------------------------------------

function mergeEnvSchemas(config: HarnessConfig, packs: LoadedPack[]): EnvVarSpec[] {
  const seen = new Map<string, EnvVarSpec>();
  for (const spec of config.envSchema ?? []) seen.set(spec.name, spec);
  for (const loaded of packs) {
    for (const spec of loaded.pack.envSchema ?? []) {
      if (!seen.has(spec.name)) seen.set(spec.name, spec);
    }
  }
  // Always add the model-provider api key.
  if (config.model.provider === "anthropic" && !seen.has("ANTHROPIC_API_KEY")) {
    seen.set("ANTHROPIC_API_KEY", {
      name: "ANTHROPIC_API_KEY",
      required: true,
      secret: true,
      description: "Anthropic API key for the agent's model.",
    });
  }
  if (config.model.provider === "openai-compat" && !seen.has("OPENAI_API_KEY")) {
    seen.set("OPENAI_API_KEY", {
      name: "OPENAI_API_KEY",
      required: true,
      secret: true,
      description: "OpenAI-compatible API key for the agent's model.",
    });
  }
  return [...seen.values()];
}

function packNeedsKv(loaded: LoadedPack): boolean {
  // For now, packs don't declare KV requirements explicitly; reserve
  // this hook for a future `requiresKv` field on CapabilityPack.
  void loaded;
  return false;
}

// ----------------------------------------------------------------------
// Naming helpers
// ----------------------------------------------------------------------

function dbName(config: HarnessConfig): string {
  return `${config.name}-db`;
}

function kvName(config: HarnessConfig): string {
  return `${config.name}-kv`;
}

function workerQueue(config: HarnessConfig): string {
  return `${config.name}-runs`;
}

function defaultBuildCommand(packageName: string): string {
  return `corepack enable && pnpm install --frozen-lockfile && pnpm --filter ${packageName} build`;
}

// ----------------------------------------------------------------------
// Render Blueprint shape
//
// We don't import a generated type from Render because there isn't a
// canonical TS package. Instead we model the slice of the schema we
// actually emit, mirroring the hand-authored examples in /blueprints.
// ----------------------------------------------------------------------

export interface Blueprint {
  databases?: BlueprintDatabase[];
  services?: BlueprintService[];
}

export interface BlueprintDatabase {
  name: string;
  plan: string;
  region?: string;
  postgresMajorVersion?: string;
}

export interface BlueprintEnvVar {
  key: string;
  value?: string;
  sync?: false;
  fromDatabase?: { name: string; property: string };
  fromService?: { name: string; type: string; property: string };
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
  const body = stringifyYaml(bp, {
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
