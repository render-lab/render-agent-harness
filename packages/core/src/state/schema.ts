import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Stable 64-bit id for the harness's migration advisory lock. Picked
 * once and never changed — derived from a hash of "render-harness:
 * migrations" so it doesn't collide with anything else in pg_locks.
 */
const MIGRATION_LOCK_ID = 7374737831n;

/**
 * Apply built-in migrations against the harness Postgres database.
 *
 * Idempotent: each migration is `CREATE ... IF NOT EXISTS`. Safe to run on
 * boot of every runtime. Returns the list of migration files applied.
 *
 * **Concurrency**: bundles boot web + worker + cron processes in
 * parallel and each one calls `applyMigrations` independently. Postgres
 * `CREATE TABLE IF NOT EXISTS` has a known race where two concurrent
 * sessions both see "table doesn't exist", both try to create it, and
 * one hits `duplicate key value violates unique constraint
 * "pg_type_typname_nsp_index"`. We wrap migrations in a session-level
 * advisory lock so concurrent callers serialize — first one in does
 * the actual DDL, the rest acquire the lock after release and find
 * every `IF NOT EXISTS` a no-op.
 */
export async function applyMigrations(pool: Pool): Promise<string[]> {
  const migrations = ["0001_init.sql", "0002_conversations.sql"];
  const applied: string[] = [];

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID.toString()]);
    try {
      for (const name of migrations) {
        // sql/ ships next to the built dist/, copied via package.json `files`.
        // From dist/state/schema.js → dist/../sql/<name> resolves the same as
        // src/state/schema.ts → src/../sql/<name> in dev.
        const candidates = [join(HERE, "..", "..", "sql", name), join(HERE, "..", "sql", name)];
        let sql: string | null = null;
        for (const path of candidates) {
          try {
            sql = readFileSync(path, "utf8");
            break;
          } catch {
            // try next candidate
          }
        }
        if (!sql) {
          throw new Error(`applyMigrations: could not locate ${name}`);
        }
        await client.query(sql);
        applied.push(name);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [
        MIGRATION_LOCK_ID.toString(),
      ]);
    }
  } finally {
    client.release();
  }
  return applied;
}
