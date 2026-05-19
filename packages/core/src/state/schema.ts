import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Stable 64-bit id for the harness's migration advisory lock. Picked
 * once and never changed — derived from a hash of "render-harness:
 * migrations" so it doesn't collide with anything else in pg_locks.
 */
const MIGRATION_LOCK_ID = 7374737831n;

/**
 * A SQL migration contributed by a capability pack. The `id` must be
 * stable for the lifetime of the pack — the runner records `(packName,
 * id)` as the dedup key in `agent_pack_migrations`. The `sql` body
 * should be idempotent on its own (the same SQL may execute on a fresh
 * database that's never run it, or on an existing database where it
 * has — though the runner is what guarantees the latter via the
 * tracking table, so packs primarily need to handle the former).
 *
 * Conventional id format: `0001_descriptive_name`, mirroring core's
 * own migration filenames. The number ordering controls apply order
 * within a single pack.
 */
export interface MigrationFile {
  id: string;
  sql: string;
}

/**
 * A pack migration carrying the originating pack name. Constructed by
 * the registry's `defineFromConfig` when it walks each loaded pack's
 * `migrations` slot. Surfaced to the runtime via
 * `AgentDefinition.packMigrations` and applied at boot by
 * `applyMigrations(pool, { packMigrations })`.
 */
export interface PackMigration extends MigrationFile {
  packName: string;
}

/**
 * Apply built-in migrations against the harness Postgres database.
 *
 * Idempotent: each migration is `CREATE ... IF NOT EXISTS`. Safe to run on
 * boot of every runtime. Returns the list of migration files applied
 * (core migrations by filename + pack migrations as `"<pack>:<id>"`).
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
 *
 * **Pack migrations**: when `opts.packMigrations` is non-empty, the
 * runner also walks pack-contributed migrations under the same
 * advisory lock, after core migrations finish. Each pack migration
 * runs in its own transaction with `(packName, id)` recorded in
 * `agent_pack_migrations` on success. The runner skips entries
 * already present in that table, so callers can safely pass the full
 * `agent.packMigrations` array on every boot. A failing pack
 * migration aborts boot with an actionable error naming the pack +
 * migration id + raw SQL error.
 */
export async function applyMigrations(
  pool: Pool,
  opts: { packMigrations?: PackMigration[] } = {},
): Promise<string[]> {
  const coreMigrations = [
    "0001_init.sql",
    "0002_conversations.sql",
    "0003_schedules.sql",
    "0004_connections.sql",
    "0005_pack_migrations.sql",
  ];
  const applied: string[] = [];

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID.toString()]);
    try {
      for (const name of coreMigrations) {
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
      // Pack migrations run after core migrations so they can rely on
      // core tables (e.g. agent_pack_migrations from 0005_pack_migrations.sql)
      // being present.
      if (opts.packMigrations && opts.packMigrations.length > 0) {
        const packApplied = await applyPackMigrationsLocked(client, opts.packMigrations);
        applied.push(...packApplied);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID.toString()]);
    }
  } finally {
    client.release();
  }
  return applied;
}

/**
 * Apply pack-contributed migrations. Caller must already hold the
 * migration advisory lock and have run core migrations (so
 * `agent_pack_migrations` exists). Each migration runs in its own
 * transaction; on failure the transaction is rolled back and an
 * actionable error is thrown.
 *
 * Dedup is by `(packName, id)` against `agent_pack_migrations`. Two
 * agents in the same bundle that both contribute the same pack
 * migration end up with one row, applied once.
 */
async function applyPackMigrationsLocked(
  client: PoolClient,
  packMigrations: PackMigration[],
): Promise<string[]> {
  const applied: string[] = [];
  // Pull every already-applied (packName, id) in one round-trip rather
  // than checking row-by-row.
  const existingRes = await client.query<{ pack_name: string; migration_id: string }>(
    "SELECT pack_name, migration_id FROM agent_pack_migrations",
  );
  const existing = new Set(existingRes.rows.map((r) => `${r.pack_name}\u0000${r.migration_id}`));
  // Dedup by (packName, id) within the input array too — if two
  // agents in a bundle both contribute the same pack, we only run the
  // migration once.
  const seenInput = new Set<string>();
  for (const m of packMigrations) {
    const key = `${m.packName}\u0000${m.id}`;
    if (seenInput.has(key)) continue;
    seenInput.add(key);
    if (existing.has(key)) continue;
    try {
      await client.query("BEGIN");
      await client.query(m.sql);
      await client.query(
        "INSERT INTO agent_pack_migrations (pack_name, migration_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [m.packName, m.id],
      );
      await client.query("COMMIT");
      applied.push(`${m.packName}:${m.id}`);
    } catch (err) {
      // Rollback first, then surface an actionable error including
      // the pack name + migration id + underlying message so an
      // operator can find the broken SQL quickly.
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore — original error is what matters
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `applyMigrations: pack migration "${m.packName}:${m.id}" failed and was rolled back. ` +
          `Fix the SQL in the pack's \`migrations\` slot and redeploy. Underlying error: ${msg}`,
      );
    }
  }
  return applied;
}
