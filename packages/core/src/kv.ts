import { Redis, type RedisOptions } from "ioredis";
import type { KvLike } from "./cancel.js";

/**
 * Render Key Value (Valkey 8) is Redis-compatible. The harness uses it for
 * ephemeral signals only — cancellation, locks, deduplication tokens — never
 * for state. State always lives in Postgres.
 *
 * Two construction shapes:
 *
 *   getKv()                — read REDIS_URL or KV_URL from env
 *   getKv({ url: "..." })  — explicit URL
 */
export function getKv(opts?: { url?: string; options?: RedisOptions }): KvLike {
  const url = opts?.url ?? process.env.KV_URL ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "getKv: KV_URL (or REDIS_URL) must be set. On Render, link a Key Value instance and the harness will read its connection string.",
    );
  }
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    ...opts?.options,
  });
  return wrap(client);
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
