import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Apply built-in migrations against the harness Postgres database.
 *
 * Idempotent: each migration is `CREATE ... IF NOT EXISTS`. Safe to run on
 * boot of every runtime. Returns the list of migration files applied.
 */
export async function applyMigrations(pool: Pool): Promise<string[]> {
  const migrations = ["0001_init.sql"];
  const applied: string[] = [];
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
    await pool.query(sql);
    applied.push(name);
  }
  return applied;
}
