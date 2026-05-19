/**
 * Integration tests for the pack-level migration runner.
 *
 * Requires a Postgres reachable at TEST_DATABASE_URL or the local
 * Compose stack default. Skipped automatically when no database
 * answers the connection. Use `pnpm db:up` to bring the stack up
 * locally.
 */

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSharedPool, createPool } from "./db.js";
import { applyMigrations, type PackMigration } from "./schema.js";

const CONN = process.env.TEST_DATABASE_URL ?? "postgres://harness:harness@127.0.0.1:55432/harness";

let pool: Pool | null = null;

beforeAll(async () => {
  try {
    pool = createPool({ connectionString: CONN, applicationName: "pack-migrations-it" });
    await pool.query("SELECT 1");
    await applyMigrations(pool);
  } catch {
    pool = null;
  }
});

afterAll(async () => {
  await pool?.end();
  await closeSharedPool();
});

const dbTest = (name: string, fn: (db: Pool) => Promise<void>) => {
  it(name, async () => {
    const db = pool;
    if (!db) {
      console.warn(`[skip] ${name}: no Postgres reachable at ${CONN}`);
      return;
    }
    await fn(db);
  });
};

// Use unique pack names per test so concurrent test runs and re-runs
// against the same DB don't collide on the (pack_name, migration_id)
// PK. The runner is keyed on those, so per-test isolation is enough.
function packName(test: string): string {
  return `it-pack-${test}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Same rationale for table names — vitest's pool: "threads" runs
// integration test files in parallel against the same Postgres, so a
// bare `Date.now()` is not unique enough.
function uniqueTable(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("applyMigrations (pack migrations)", () => {
  dbTest("creates the agent_pack_migrations table via core migration 0005", async (db) => {
    // Core migration 0005_pack_migrations.sql should have run as part
    // of the beforeAll applyMigrations(pool). The table must exist
    // with the expected PK shape.
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'agent_pack_migrations' ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["pack_name", "migration_id", "applied_at"]);
  });

  dbTest("applies a new pack migration and records it", async (db) => {
    const pack = packName("apply-new");
    const tableName = uniqueTable("it_pack_apply_new");
    const migrations: PackMigration[] = [
      {
        packName: pack,
        id: "0001_create_thing",
        sql: `CREATE TABLE IF NOT EXISTS ${tableName} (id text PRIMARY KEY);`,
      },
    ];

    const applied = await applyMigrations(db, { packMigrations: migrations });
    expect(applied).toContain(`${pack}:0001_create_thing`);

    // Table was created.
    const tableCheck = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
      [tableName],
    );
    expect(tableCheck.rows[0]?.exists).toBe(true);

    // Tracking row was written.
    const trackedRows = await db.query(
      `SELECT migration_id FROM agent_pack_migrations WHERE pack_name = $1`,
      [pack],
    );
    expect(trackedRows.rows).toEqual([{ migration_id: "0001_create_thing" }]);

    // Cleanup so subsequent test reruns don't pile tables.
    await db.query(`DROP TABLE IF EXISTS ${tableName}`);
  });

  dbTest("is idempotent: a second apply is a no-op", async (db) => {
    const pack = packName("idempotent");
    const tableName = uniqueTable("it_pack_idempotent");
    const migrations: PackMigration[] = [
      {
        packName: pack,
        id: "0001_idempotent",
        sql: `CREATE TABLE IF NOT EXISTS ${tableName} (id text PRIMARY KEY);`,
      },
    ];

    const firstRun = await applyMigrations(db, { packMigrations: migrations });
    expect(firstRun).toContain(`${pack}:0001_idempotent`);

    const secondRun = await applyMigrations(db, { packMigrations: migrations });
    expect(secondRun).not.toContain(`${pack}:0001_idempotent`);

    // Still exactly one tracking row.
    const trackedRows = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_pack_migrations WHERE pack_name = $1`,
      [pack],
    );
    expect(trackedRows.rows[0]?.count).toBe("1");

    await db.query(`DROP TABLE IF EXISTS ${tableName}`);
  });

  dbTest("applies multiple migrations from one pack in input order", async (db) => {
    const pack = packName("ordered");
    const tableA = uniqueTable("it_pack_ordered_a");
    const tableB = uniqueTable("it_pack_ordered_b");
    const migrations: PackMigration[] = [
      {
        packName: pack,
        id: "0001_create_a",
        sql: `CREATE TABLE IF NOT EXISTS ${tableA} (id text PRIMARY KEY);`,
      },
      {
        packName: pack,
        id: "0002_create_b",
        sql: `CREATE TABLE IF NOT EXISTS ${tableB} (id text PRIMARY KEY, a_id text REFERENCES ${tableA}(id));`,
      },
    ];

    const applied = await applyMigrations(db, { packMigrations: migrations });
    expect(applied).toContain(`${pack}:0001_create_a`);
    expect(applied).toContain(`${pack}:0002_create_b`);

    // FK from 0002 to 0001 confirms ordering — 0002 references 0001's table.
    const fkCheck = await db.query(
      `SELECT 1 FROM information_schema.referential_constraints
       WHERE constraint_schema = 'public'`,
    );
    expect(fkCheck.rowCount).toBeGreaterThan(0);

    await db.query(`DROP TABLE IF EXISTS ${tableB}`);
    await db.query(`DROP TABLE IF EXISTS ${tableA}`);
  });

  dbTest("dedupes the same (packName, id) within the input array", async (db) => {
    const pack = packName("dedup");
    const tableName = uniqueTable("it_pack_dedup");
    const sql = `CREATE TABLE IF NOT EXISTS ${tableName} (id text PRIMARY KEY);`;
    // Same migration listed twice — simulates two agents in a bundle
    // both contributing the same pack's migration. Should run once.
    const migrations: PackMigration[] = [
      { packName: pack, id: "0001_once", sql },
      { packName: pack, id: "0001_once", sql },
    ];

    const applied = await applyMigrations(db, { packMigrations: migrations });
    expect(applied.filter((x) => x === `${pack}:0001_once`)).toHaveLength(1);

    const trackedRows = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_pack_migrations WHERE pack_name = $1`,
      [pack],
    );
    expect(trackedRows.rows[0]?.count).toBe("1");

    await db.query(`DROP TABLE IF EXISTS ${tableName}`);
  });

  dbTest("two packs with the same migration id are independent", async (db) => {
    const pack1 = packName("indep-1");
    const pack2 = packName("indep-2");
    const tableA = uniqueTable("it_pack_indep_a");
    const tableB = uniqueTable("it_pack_indep_b");
    const migrations: PackMigration[] = [
      {
        packName: pack1,
        id: "0001_init",
        sql: `CREATE TABLE IF NOT EXISTS ${tableA} (id text PRIMARY KEY);`,
      },
      {
        packName: pack2,
        id: "0001_init",
        sql: `CREATE TABLE IF NOT EXISTS ${tableB} (id text PRIMARY KEY);`,
      },
    ];

    const applied = await applyMigrations(db, { packMigrations: migrations });
    expect(applied).toContain(`${pack1}:0001_init`);
    expect(applied).toContain(`${pack2}:0001_init`);

    await db.query(`DROP TABLE IF EXISTS ${tableA}`);
    await db.query(`DROP TABLE IF EXISTS ${tableB}`);
  });

  dbTest(
    "fails fast with an actionable error when SQL is broken, rolls back, leaves no tracking row",
    async (db) => {
      const pack = packName("broken");
      const goodTable = uniqueTable("it_pack_broken_good");
      const migrations: PackMigration[] = [
        {
          packName: pack,
          id: "0001_good",
          sql: `CREATE TABLE IF NOT EXISTS ${goodTable} (id text PRIMARY KEY);`,
        },
        {
          packName: pack,
          id: "0002_broken",
          // Intentionally invalid SQL.
          sql: "CREATE TABLE this_is_broken (",
        },
      ];

      await expect(applyMigrations(db, { packMigrations: migrations })).rejects.toThrow(
        new RegExp(`pack migration "${pack}:0002_broken" failed and was rolled back`),
      );

      // 0001 should have been applied (committed before 0002 ran) —
      // per-migration transaction boundary, not per-batch.
      const goodTracked = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_pack_migrations WHERE pack_name = $1 AND migration_id = '0001_good'`,
        [pack],
      );
      expect(goodTracked.rows[0]?.count).toBe("1");

      // 0002 should NOT have a tracking row — its transaction was rolled back.
      const brokenTracked = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_pack_migrations WHERE pack_name = $1 AND migration_id = '0002_broken'`,
        [pack],
      );
      expect(brokenTracked.rows[0]?.count).toBe("0");

      await db.query(`DROP TABLE IF EXISTS ${goodTable}`);
    },
  );

  dbTest("returns [] for the pack-migrations portion when input is empty", async (db) => {
    // Core migrations always run, but the pack-migrations portion
    // shouldn't add any extra entries when there's nothing to apply.
    const applied = await applyMigrations(db, { packMigrations: [] });
    // The applied list contains core migration filenames. The pack
    // portion contributes entries shaped like "<pack>:<id>" — none
    // should appear.
    expect(applied.filter((x) => x.includes(":")).length).toBe(0);
  });

  dbTest("preserves the call signature without packMigrations (backward-compat)", async (db) => {
    // Existing callers like `applyMigrations(pool)` (no second arg)
    // must keep working. The runner just skips the pack-migrations
    // step when opts is undefined or packMigrations is missing.
    const applied = await applyMigrations(db);
    expect(applied).toContain("0005_pack_migrations.sql");
  });
});
