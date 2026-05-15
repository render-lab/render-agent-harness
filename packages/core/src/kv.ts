import { Redis, type RedisOptions } from "ioredis";
import type { KvLike } from "./cancel.js";
import type { Logger } from "./logger.js";

/**
 * Render Key Value (Valkey 8) is Redis-compatible. The harness uses it for
 * ephemeral signals only — cancellation, locks, deduplication tokens — never
 * for state. State always lives in Postgres.
 *
 * Two construction shapes:
 *
 *   getKv()                — process-shared singleton, reads KV_URL/REDIS_URL from env
 *   getKv({ url: "..." })  — explicit URL or options, returns a NEW (non-cached) instance
 *
 * Use the no-arg form for runtime callers — request handlers should not open a
 * fresh connection per request. Use the explicit form for tests or multi-tenant
 * scenarios where you genuinely need a private client.
 */
let sharedClient: Redis | null = null;
let sharedKv: KvLike | null = null;

export function getKv(opts?: { url?: string; options?: RedisOptions }): KvLike {
  if (opts?.url || opts?.options) {
    const url = opts.url ?? process.env.KV_URL ?? process.env.REDIS_URL;
    if (!url) throw new Error(missingUrlMessage());
    return wrap(new Redis(url, defaultRedisOptions(opts.options)));
  }
  if (sharedKv) return sharedKv;
  const url = process.env.KV_URL ?? process.env.REDIS_URL;
  if (!url) throw new Error(missingUrlMessage());
  sharedClient = new Redis(url, defaultRedisOptions());
  sharedKv = wrap(sharedClient);
  return sharedKv;
}

/**
 * Like {@link getKv}, but returns null and emits a debug log when no KV is
 * configured. Use this where KV is optional (e.g., cancel polling is
 * best-effort if REDIS_URL is unset).
 */
export function getKvSafe(logger?: Logger): KvLike | null {
  try {
    return getKv();
  } catch (err) {
    logger?.debug({ err: err instanceof Error ? err.message : String(err) }, "no KV configured");
    return null;
  }
}

/** Close the process-shared KV client. Used in graceful shutdown and tests. */
export async function closeSharedKv(): Promise<void> {
  const client = sharedClient;
  sharedClient = null;
  sharedKv = null;
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

function defaultRedisOptions(extra?: RedisOptions): RedisOptions {
  return {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    ...extra,
  };
}

function missingUrlMessage(): string {
  return "getKv: KV_URL (or REDIS_URL) must be set. On Render, link a Key Value instance and the harness will read its connection string.";
}

function wrap(client: Redis): KvLike {
  return {
    get: (k) => client.get(k),
    set: (k, v, mode, ttl) => {
      if (mode && ttl !== undefined) {
        return client.set(k, v, mode, ttl);
      }
      return client.set(k, v);
    },
    del: (k) => client.del(k),
  };
}

/**
 * Build an in-memory KvLike for tests. Honors EX TTL semantics.
 */
export function memoryKv(): KvLike & {
  _entries: Map<string, { value: string; expiresAt: number | null }>;
} {
  const entries = new Map<string, { value: string; expiresAt: number | null }>();
  const get = async (k: string) => {
    const e = entries.get(k);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt < Date.now()) {
      entries.delete(k);
      return null;
    }
    return e.value;
  };
  return {
    _entries: entries,
    get,
    set: async (k, v, mode, ttl) => {
      const expiresAt = mode === "EX" && ttl !== undefined ? Date.now() + ttl * 1000 : null;
      entries.set(k, { value: v, expiresAt });
      return "OK";
    },
    del: async (k) => {
      const had = entries.delete(k);
      return had ? 1 : 0;
    },
  };
}
