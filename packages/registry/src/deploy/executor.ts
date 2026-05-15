/**
 * Walks a deploy plan and creates each resource via the Render API.
 *
 * Sequencing:
 *   1. Datastores first (postgres, key_value) — services env-var
 *      references resolve to their connection strings.
 *   2. Services and the workflow (which can reference databases via
 *      `__RESOLVE_FROM_DATABASE:<name>:<prop>__` sentinels in env values).
 *
 * Lock file is persisted after every successful create so a crash
 * mid-deploy leaves a consistent state. Re-runs read the lock and
 * skip already-created resources (update support is a v2 — for now we
 * lean on Render's auto-deploy on git push for code changes).
 */

import type {
  CreateServiceBody,
  CreateServiceEnvVar,
  CreateWorkflowBody,
  RenderApi,
} from "./api.js";
import type { DeployLock } from "./lock.js";
import { emptyLock, recordResource } from "./lock.js";
import type { DeployPlan, PlannedResource } from "./planner.js";

export interface ExecutorOpts {
  api: RenderApi;
  plan: DeployPlan;
  projectRoot: string;
  ownerId: string;
  existingLock: DeployLock | null;
  /**
   * When true, log what would happen and return without calling the
   * Render API. Useful for verifying the plan before paying for
   * services.
   */
  dryRun?: boolean;
  /** Logger sink — defaults to console. */
  log?: (line: string) => void;
}

export interface ExecutorResult {
  /** Final lock after deploy. */
  lock: DeployLock;
  /** Resources that were newly created (vs. found in the lock). */
  created: string[];
  /** Resources skipped because the lock already had them. */
  skipped: string[];
}

export async function executePlan(opts: ExecutorOpts): Promise<ExecutorResult> {
  const log = opts.log ?? ((line) => process.stdout.write(`${line}\n`));
  let lock = opts.existingLock ?? emptyLock(opts.ownerId);
  const created: string[] = [];
  const skipped: string[] = [];

  // Sort resources: datastores first so their connection strings can
  // resolve later sentinels.
  const ordered = orderResources(opts.plan.resources);

  // Collected connection-string substitutions as we create datastores.
  // Key = sentinel target, e.g. `${dbName}:connectionString`. Value =
  // the resolved string we splice into downstream services' envVars.
  const resolved = new Map<string, string>();

  for (const resource of ordered) {
    const inLock = lock.resources[resource.name];
    if (inLock) {
      log(`  ✓ ${resource.name} already deployed (id ${inLock.id}, skipping)`);
      skipped.push(resource.name);
      // For datastores, fetch + remember the connection string so
      // downstream services in this same deploy still resolve.
      if (resource.kind === "postgres") {
        const info = await opts.api.getPostgresConnectionInfo(inLock.id);
        resolved.set(`${resource.name}:connectionString`, info.internalConnectionString);
      } else if (resource.kind === "key_value") {
        const info = await opts.api.getKeyValueConnectionInfo(inLock.id);
        resolved.set(`${resource.name}:connectionString`, info.internalConnectionString);
      }
      continue;
    }

    if (opts.dryRun) {
      log(`  + ${describePlanned(resource)} (dry-run — not creating)`);
      created.push(resource.name);
      continue;
    }

    log(`  + ${describePlanned(resource)}`);
    const id = await createResource(opts.api, resource, resolved);
    lock = await recordResource(opts.projectRoot, lock, {
      name: resource.name,
      kind:
        resource.kind === "service" ? resource.subkind : (resource.kind as DeployLock["resources"][string]["kind"]),
      id,
    });
    created.push(resource.name);

    if (resource.kind === "postgres") {
      const info = await opts.api.getPostgresConnectionInfo(id);
      resolved.set(`${resource.name}:connectionString`, info.internalConnectionString);
    } else if (resource.kind === "key_value") {
      const info = await opts.api.getKeyValueConnectionInfo(id);
      resolved.set(`${resource.name}:connectionString`, info.internalConnectionString);
    }
  }

  return { lock, created, skipped };
}

function orderResources(resources: PlannedResource[]): PlannedResource[] {
  const datastores: PlannedResource[] = [];
  const services: PlannedResource[] = [];
  const workflow: PlannedResource[] = [];
  for (const r of resources) {
    if (r.kind === "postgres" || r.kind === "key_value") datastores.push(r);
    else if (r.kind === "workflow") workflow.push(r);
    else services.push(r);
  }
  return [...datastores, ...services, ...workflow];
}

async function createResource(
  api: RenderApi,
  resource: PlannedResource,
  resolved: Map<string, string>,
): Promise<string> {
  switch (resource.kind) {
    case "postgres": {
      const ref = await api.createPostgres(resource.body);
      return ref.id;
    }
    case "key_value": {
      const ref = await api.createKeyValue(resource.body);
      return ref.id;
    }
    case "service": {
      const body: CreateServiceBody = {
        ...resource.body,
        ...(resource.body.envVars
          ? { envVars: resolveEnvVars(resource.body.envVars, resolved) }
          : {}),
      };
      const ref = await api.createService(body);
      return ref.id;
    }
    case "workflow": {
      const body: CreateWorkflowBody = {
        ...resource.body,
        ...(resource.body.envVars
          ? { envVars: resolveEnvVars(resource.body.envVars, resolved) }
          : {}),
      };
      const ref = await api.createWorkflow(body);
      return ref.id;
    }
  }
}

const SENTINEL = /^__RESOLVE_FROM_(?:DATABASE|SERVICE):([^:]+):([^_]+)__$/;

function resolveEnvVars(
  envVars: CreateServiceEnvVar[],
  resolved: Map<string, string>,
): CreateServiceEnvVar[] {
  return envVars.map((v) => {
    if (v.value === undefined) return v;
    const m = SENTINEL.exec(v.value);
    if (!m) return v;
    const [, name, prop] = m;
    const key = `${name}:${prop}`;
    const value = resolved.get(key);
    if (!value) {
      throw new Error(
        `deploy: env var ${v.key} references ${key} but no datastore with that name has been created yet. Check the resource ordering.`,
      );
    }
    return { ...v, value };
  });
}

function describePlanned(r: PlannedResource): string {
  switch (r.kind) {
    case "postgres":
      return `postgres ${r.name} (plan ${r.body.plan}, region ${r.body.region})`;
    case "key_value":
      return `key_value ${r.name} (plan ${r.body.plan})`;
    case "service":
      return `${r.subkind} ${r.name}`;
    case "workflow":
      return `workflow ${r.name}`;
  }
}
