/**
 * Lock file persistence for `render-harness deploy`. Maps each
 * resource's stable logical name (the value the deploy planner emits)
 * to the Render-side service id returned at create time. Re-runs read
 * this file, skip creation for resources that already exist, and
 * (eventually) call update endpoints to push diffs.
 */

import { readFile, writeFile } from "node:fs/promises";

const LOCK_FILE_NAME = ".render-deploy.lock.json";

export type ResourceKind =
  | "postgres"
  | "key_value"
  | "web_service"
  | "private_service"
  | "background_worker"
  | "cron_job"
  | "workflow";

export interface LockedResource {
  /** Stable logical name from the deploy plan (matches Render service name). */
  name: string;
  kind: ResourceKind;
  /** Render-side resource id. */
  id: string;
  /** ISO timestamp of last successful sync. */
  syncedAt: string;
}

export interface DeployLock {
  schemaVersion: 1;
  /** Owner/workspace id this deployment lives in. */
  ownerId: string;
  /** Resource map keyed by logical name. */
  resources: Record<string, LockedResource>;
}

const EMPTY_LOCK = (ownerId: string): DeployLock => ({
  schemaVersion: 1,
  ownerId,
  resources: {},
});

/**
 * Read the lock file at the given project root. Returns null if no
 * lock exists yet — caller treats that as "first deploy."
 */
export async function readLock(projectRoot: string): Promise<DeployLock | null> {
  const path = lockPath(projectRoot);
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as DeployLock;
    if (parsed.schemaVersion !== 1) {
      throw new Error(`unsupported render-deploy lock schema version: ${parsed.schemaVersion}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeLock(projectRoot: string, lock: DeployLock): Promise<void> {
  const path = lockPath(projectRoot);
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

/**
 * Convenience to update one resource and persist. Used by the executor
 * after each successful create call so a mid-deploy crash leaves us
 * with a partial-but-consistent lock.
 */
export async function recordResource(
  projectRoot: string,
  lock: DeployLock,
  resource: Omit<LockedResource, "syncedAt">,
): Promise<DeployLock> {
  const next: DeployLock = {
    ...lock,
    resources: {
      ...lock.resources,
      [resource.name]: {
        ...resource,
        syncedAt: new Date().toISOString(),
      },
    },
  };
  await writeLock(projectRoot, next);
  return next;
}

export function emptyLock(ownerId: string): DeployLock {
  return EMPTY_LOCK(ownerId);
}

export function lockFileName(): string {
  return LOCK_FILE_NAME;
}

function lockPath(projectRoot: string): string {
  return `${projectRoot.replace(/\/$/, "")}/${LOCK_FILE_NAME}`;
}
