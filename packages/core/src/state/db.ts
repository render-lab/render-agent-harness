import pg from "pg";

const { Pool } = pg;

export type { Pool, PoolClient } from "pg";

export interface PoolConfig {
  /** Override the connection string. Defaults to `DATABASE_URL` from env. */
  connectionString?: string;
  /** Max pool size. Defaults to 10. */
  max?: number;
  /** Application name surfaced in pg_stat_activity. */
  applicationName?: string;
}

let sharedPool: pg.Pool | null = null;

/**
 * Get a process-shared Postgres pool. The harness uses a single pool per
 * process; runtimes can build their own pools with {@link createPool} when
 * they need isolation.
 */
export function getPool(config?: PoolConfig): pg.Pool {
  if (sharedPool) return sharedPool;
  const connectionString = config?.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("getPool: DATABASE_URL is not set and no connectionString was provided");
  }
  sharedPool = createPool({
    connectionString,
    ...(config?.max !== undefined ? { max: config.max } : {}),
    ...(config?.applicationName !== undefined ? { applicationName: config.applicationName } : {}),
  });
  return sharedPool;
}

export function createPool(config: PoolConfig): pg.Pool {
  const connectionString = config.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("createPool: connectionString is required (or set DATABASE_URL)");
  }
  return new Pool({
    connectionString,
    max: config.max ?? 10,
    application_name: config.applicationName ?? "render-harness",
    keepAlive: true,
  });
}

/** Close the shared pool. Used in tests and graceful shutdown. */
export async function closeSharedPool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}
