/**
 * Translates an emitted `Blueprint` (plus the V2 workflow facts that
 * don't fit in Blueprint) into a list of `PlannedResource`s — concrete
 * API request bodies the executor walks.
 *
 * Single source of truth for *what* gets deployed lives in the emitter
 * (`emitBlueprint`). The planner just reshapes the Blueprint's
 * `databases` + `services` into request bodies, plus appends one
 * workflow resource if the bundle has any workflow-task agents.
 */

import type { Blueprint, BlueprintEnvVar, BlueprintService } from "../emitter.js";
import type { HarnessConfig } from "../schema.js";
import { workflowTaskAgents } from "../schema.js";
import type {
  CreateKeyValueBody,
  CreatePostgresBody,
  CreateServiceBody,
  CreateServiceEnvVar,
  CreateWorkflowBody,
  ServiceDetails,
  ServiceType,
} from "./api.js";

export type PlannedResource =
  | { kind: "postgres"; name: string; body: CreatePostgresBody }
  | { kind: "key_value"; name: string; body: CreateKeyValueBody }
  | { kind: "service"; subkind: ServiceType; name: string; body: CreateServiceBody }
  | { kind: "workflow"; name: string; body: CreateWorkflowBody };

export interface PlanInputs {
  blueprint: Blueprint;
  config: HarnessConfig;
  ownerId: string;
  repoUrl: string;
  branch: string;
  /**
   * Workspace-package name (e.g. `@render-harness/example-chief-of-staff`).
   * Used by build commands the emitter produced; we pass it through.
   */
  packageName: string;
  region: string;
}

export interface DeployPlan {
  resources: PlannedResource[];
}

export function planFromBlueprint(inputs: PlanInputs): DeployPlan {
  const resources: PlannedResource[] = [];

  // ── Databases ────────────────────────────────────────────────────────
  for (const db of inputs.blueprint.databases ?? []) {
    resources.push({
      kind: "postgres",
      name: db.name,
      body: {
        name: db.name,
        ownerId: inputs.ownerId,
        plan: db.plan,
        ...(db.postgresMajorVersion ? { version: db.postgresMajorVersion } : {}),
        region: db.region ?? inputs.region,
      },
    });
  }

  // ── Key Value + the four service types ─────────────────────────────
  for (const svc of inputs.blueprint.services ?? []) {
    if (svc.type === "keyvalue") {
      resources.push({
        kind: "key_value",
        name: svc.name,
        body: {
          name: svc.name,
          ownerId: inputs.ownerId,
          plan: svc.plan ?? "free",
          region: svc.region ?? inputs.region,
        },
      });
      continue;
    }
    const subkind = blueprintTypeToServiceType(svc.type);
    if (!subkind) continue; // skip pack-contributed unsupported types
    resources.push({
      kind: "service",
      subkind,
      name: svc.name,
      body: buildServiceBody({
        svc,
        subkind,
        ownerId: inputs.ownerId,
        repoUrl: inputs.repoUrl,
        branch: inputs.branch,
        region: inputs.region,
      }),
    });
  }

  // ── Workflow service ────────────────────────────────────────────────
  // The bundle deploys at most one Workflow service hosting every
  // workflow-task agent as one Render task. (Render's per-service
  // task cap is 500; one is enough for any bundle we ship today.)
  // The emitter's checklist tells the user the slug + start command;
  // we put the same values on the API request.
  if (workflowTaskAgents(inputs.config).length > 0) {
    const name = `${inputs.config.name}-workflows`;
    resources.push({
      kind: "workflow",
      name,
      body: {
        name,
        ownerId: inputs.ownerId,
        // Workflow services don't take a buildCommand at create time;
        // build/start are folded into runCommand. The harness's
        // workflow entrypoint is `node dist/workflows.js`, which is
        // built by `pnpm --filter <pkg> build`. Combine both so the
        // workflow runtime has a one-shot bootstrap.
        buildConfig: {
          runCommand: `corepack enable && pnpm install --frozen-lockfile && pnpm --filter ${inputs.packageName} build && node examples/${inputs.config.name}/dist/workflows.js`,
        },
        region: inputs.region,
        autoDeployTrigger: "commit",
        envVars: workflowEnvVars(inputs.config),
      },
    });
  }

  return { resources };
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function blueprintTypeToServiceType(t: BlueprintService["type"]): ServiceType | null {
  switch (t) {
    case "web":
      return "web_service";
    case "pserv":
      return "private_service";
    case "worker":
      return "background_worker";
    case "cron":
      return "cron_job";
    case "keyvalue":
      return null; // handled separately
    default:
      return null;
  }
}

interface BuildServiceArgs {
  svc: BlueprintService;
  subkind: ServiceType;
  ownerId: string;
  repoUrl: string;
  branch: string;
  region: string;
}

function buildServiceBody(args: BuildServiceArgs): CreateServiceBody {
  const { svc, subkind, ownerId, repoUrl, branch, region } = args;
  const env = (svc.runtime as ServiceDetails["env"] | undefined) ?? "node";
  const envVars = (svc.envVars ?? []).flatMap(toApiEnvVar);

  let serviceDetails: ServiceDetails;
  if (subkind === "web_service") {
    serviceDetails = {
      env,
      ...(svc.plan ? { plan: svc.plan } : {}),
      region: svc.region ?? region,
      ...(svc.healthCheckPath ? { healthCheckPath: svc.healthCheckPath } : {}),
      envSpecificDetails: {
        ...(svc.buildCommand ? { buildCommand: svc.buildCommand } : {}),
        ...(svc.startCommand ? { startCommand: svc.startCommand } : {}),
      },
    };
  } else if (subkind === "cron_job") {
    if (!svc.schedule) {
      throw new Error(`deploy: cron service "${svc.name}" missing schedule`);
    }
    serviceDetails = {
      env,
      ...(svc.plan ? { plan: svc.plan } : {}),
      region: svc.region ?? region,
      schedule: svc.schedule,
      ...(svc.startCommand ? { command: svc.startCommand } : {}),
      envSpecificDetails: {
        ...(svc.buildCommand ? { buildCommand: svc.buildCommand } : {}),
      },
    };
  } else {
    // private_service + background_worker share the same shape
    serviceDetails = {
      env,
      ...(svc.plan ? { plan: svc.plan } : {}),
      region: svc.region ?? region,
      envSpecificDetails: {
        ...(svc.buildCommand ? { buildCommand: svc.buildCommand } : {}),
        ...(svc.startCommand ? { startCommand: svc.startCommand } : {}),
      },
    };
  }

  return {
    type: subkind,
    name: svc.name,
    ownerId,
    repo: repoUrl,
    branch,
    autoDeploy: "yes",
    ...(svc.rootDir ? { rootDir: svc.rootDir } : {}),
    ...(envVars.length > 0 ? { envVars } : {}),
    serviceDetails,
  };
}

function toApiEnvVar(v: BlueprintEnvVar): CreateServiceEnvVar[] {
  if (!v.key) return [];
  if (v.fromDatabase) {
    // Render's services API doesn't accept fromDatabase the way Blueprint
    // YAML does. The executor resolves these refs after creating the
    // database — we emit a sentinel value here that the executor
    // replaces with the actual connection string.
    return [
      {
        key: v.key,
        value: `__RESOLVE_FROM_DATABASE:${v.fromDatabase.name}:${v.fromDatabase.property}__`,
      },
    ];
  }
  if (v.fromService) {
    return [
      {
        key: v.key,
        value: `__RESOLVE_FROM_SERVICE:${v.fromService.name}:${v.fromService.property}__`,
      },
    ];
  }
  if (v.value !== undefined) return [{ key: v.key, value: v.value }];
  // sync: false → user fills in via dashboard. Render's API just needs
  // the key to be declared (any subsequent env edit replaces the empty
  // value). Mark it sensitive.
  return [{ key: v.key, isSensitive: true }];
}

/**
 * Env vars wired onto the bundle's Workflow service. The Workflow
 * service hosts the SAME `defineFromConfig`-loaded agents the web/
 * worker run, so it needs the same DATABASE_URL + KV_URL + model
 * provider key. The executor resolves the database/KV refs.
 */
function workflowEnvVars(cfg: HarnessConfig): CreateServiceEnvVar[] {
  const out: CreateServiceEnvVar[] = [
    { key: "NODE_ENV", value: "production" },
    { key: "LOG_LEVEL", value: "info" },
    {
      key: "DATABASE_URL",
      value: `__RESOLVE_FROM_DATABASE:${cfg.name}-db:connectionString__`,
    },
    {
      key: "KV_URL",
      value: `__RESOLVE_FROM_SERVICE:${cfg.name}-kv:connectionString__`,
    },
  ];
  const model = cfg.shared?.model ?? cfg.agents.find((a) => a.model)?.model;
  if (model?.provider === "anthropic") {
    out.push({ key: "ANTHROPIC_API_KEY", isSensitive: true });
  } else if (model?.provider === "openai-compat") {
    out.push({ key: "OPENAI_API_KEY", isSensitive: true });
  }
  // Manifest-declared env vars get propagated too.
  for (const spec of cfg.envSchema ?? []) {
    if (spec.secret) out.push({ key: spec.name, isSensitive: true });
    else if (spec.default !== undefined) out.push({ key: spec.name, value: spec.default });
    else out.push({ key: spec.name, isSensitive: true });
  }
  return out;
}
