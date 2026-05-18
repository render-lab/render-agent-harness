/**
 * Wizard service Postgres pool + migration runner.
 *
 * Modeled on `packages/core/src/state/db.ts` + `state/schema.ts`. The
 * wizard runs its own database (separate from the harness's
 * `agent_runs` schema): one logical DB, two small tables defined in
 * `sql/0001_init.sql`.
 *
 * `createWizardPool` builds a fresh pool; `applyWizardMigrations`
 * advisory-locks then applies every script in `sql/` once. Both are
 * pure functions taking config as parameters so tests can swap pools.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export type { Pool, PoolClient } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Stable 64-bit id for the wizard's migration advisory lock. */
const MIGRATION_LOCK_ID = 8483626482n;

/** Migration files applied in order. */
const MIGRATIONS = ["0001_init.sql"];

export interface CreateWizardPoolOpts {
  connectionString: string;
  max?: number;
}

export function createWizardPool(opts: CreateWizardPoolOpts): pg.Pool {
  return new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 5,
    application_name: "render-harness-wizard",
    keepAlive: true,
  });
}

/**
 * Apply wizard migrations. Idempotent (every script uses
 * `CREATE ... IF NOT EXISTS`); safe to run on every boot. Returns the
 * list of files applied.
 */
export async function applyWizardMigrations(pool: pg.Pool): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID.toString()]);
    try {
      for (const name of MIGRATIONS) {
        const sql = readMigration(name);
        await client.query(sql);
        applied.push(name);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID.toString()]);
    }
  } finally {
    client.release();
  }
  return applied;
}

function readMigration(name: string): string {
  // In dev `HERE` is `src/`; in prod it's `dist/`. The sql/ dir lives
  // next to both, so resolve relative to `..` from `HERE`.
  const candidates = [join(HERE, "..", "sql", name), join(HERE, "sql", name)];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next candidate
    }
  }
  throw new Error(`applyWizardMigrations: could not locate ${name} in any of ${candidates.join(", ")}`);
}
