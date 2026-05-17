/**
 * cap-memory-pg — long-term memory backed by Postgres.
 *
 * Adds two LocalToolHandlers an agent can use to write durable notes
 * across runs and search them with fuzzy text matching.
 *
 *   - memory.write    { key, value, tags? }   → stores a note.
 *   - memory.search   { query, limit?, tags? } → returns ranked matches.
 *
 * The pack uses Postgres `pg_trgm` for fuzzy similarity. We don't pull
 * in pgvector for v1 — keeps the dependency surface tiny and avoids
 * extension issues on Render's managed Postgres.
 *
 * Usage in render-harness.yaml:
 *
 *   capabilities:
 *     - pack: "@render-harness/cap-memory-pg"
 *       config:
 *         namespace: "support"   # optional; default: entry.name
 *
 * The Postgres table is bootstrapped lazily on first tool call:
 * `CREATE TABLE IF NOT EXISTS` and `CREATE EXTENSION IF NOT EXISTS pg_trgm`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, type LocalToolHandler, type SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "skills");

interface MemoryConfig {
  namespace?: string;
}

const SCHEMA_BOOTSTRAP_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS agent_memory (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_memory_ns_key UNIQUE (namespace, key)
);
CREATE INDEX IF NOT EXISTS agent_memory_ns_idx ON agent_memory (namespace);
CREATE INDEX IF NOT EXISTS agent_memory_value_trgm
  ON agent_memory USING gin (value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS agent_memory_tags_idx ON agent_memory USING gin (tags);
`;

let bootstrapped = false;
async function ensureSchema(): Promise<void> {
  if (bootstrapped) return;
  const pool = getPool();
  await pool.query(SCHEMA_BOOTSTRAP_SQL);
  bootstrapped = true;
}

const pack = definePack({
  name: "cap-memory-pg",
  version: pkg.version,
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = ctx.config as MemoryConfig;
    const namespace = cfg.namespace ?? ctx.entryName;

    const writeMemory: LocalToolHandler = {
      definition: {
        name: "write",
        description:
          "Store a durable note in long-term memory. Notes survive across runs of this agent. Use for facts the user wants you to remember (preferences, names, decisions). The (key) is unique per namespace; calling write twice with the same key updates the value.",
        source: "pack:cap-memory-pg",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: {
              type: "string",
              description: "Stable identifier. Reuse the same key to update.",
              minLength: 1,
              maxLength: 256,
            },
            value: {
              type: "string",
              description: "The note body.",
              minLength: 1,
              maxLength: 10_000,
            },
            tags: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 64 },
              description: "Optional category tags for filtering on search.",
              maxItems: 16,
            },
          },
          required: ["key", "value"],
        },
      },
      async handler({ input }) {
        const args = (input ?? {}) as { key?: string; value?: string; tags?: string[] };
        if (!args.key || !args.value) {
          return { content: "memory.write: key and value are required", isError: true };
        }
        await ensureSchema();
        const pool = getPool();
        const result = await pool.query<{ id: string; updated: boolean }>(
          `INSERT INTO agent_memory (namespace, key, value, tags)
           VALUES ($1, $2, $3, COALESCE($4::text[], '{}'::text[]))
           ON CONFLICT (namespace, key) DO UPDATE SET
             value = EXCLUDED.value,
             tags = EXCLUDED.tags,
             updated_at = now()
           RETURNING id, (xmax::text::int > 0) AS updated`,
          [namespace, args.key, args.value, args.tags ?? null],
        );
        const row = result.rows[0];
        return {
          content: row
            ? `memory.write: ${row.updated ? "updated" : "created"} id=${row.id} key="${args.key}"`
            : "memory.write: stored",
        };
      },
    };

    const searchMemory: LocalToolHandler = {
      definition: {
        name: "search",
        description:
          "Search long-term memory using fuzzy text similarity. Returns the top matches ranked by trigram similarity. Use this before answering when the user asks about something they may have told you before.",
        source: "pack:cap-memory-pg",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "Free-form search text.", minLength: 1 },
            limit: {
              type: "integer",
              description: "Max rows to return. Default 10, max 50.",
              minimum: 1,
              maximum: 50,
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tag filter; row must have at least one of these.",
            },
          },
          required: ["query"],
        },
      },
      async handler({ input }) {
        const args = (input ?? {}) as { query?: string; limit?: number; tags?: string[] };
        if (!args.query) {
          return { content: "memory.search: query is required", isError: true };
        }
        await ensureSchema();
        const pool = getPool();
        const limit = Math.min(args.limit ?? 10, 50);
        const rows = await pool.query<{
          key: string;
          value: string;
          tags: string[];
          score: number;
          updated_at: Date;
        }>(
          `SELECT key, value, tags, similarity(value, $2) AS score, updated_at
           FROM agent_memory
           WHERE namespace = $1
             AND ($3::text[] IS NULL OR tags && $3::text[])
             AND value ILIKE '%' || $2 || '%' OR similarity(value, $2) > 0.1
           ORDER BY score DESC, updated_at DESC
           LIMIT $4`,
          [namespace, args.query, args.tags ?? null, limit],
        );
        if (rows.rows.length === 0) {
          return {
            content: `memory.search: no matches for "${args.query}" in namespace "${namespace}"`,
          };
        }
        const lines = rows.rows.map(
          (r, i) =>
            `${i + 1}. [${r.key}] (score=${r.score.toFixed(2)}, tags=${r.tags.join(",") || "—"})\n   ${r.value.slice(0, 600)}`,
        );
        return { content: lines.join("\n\n") };
      },
    };

    return [writeMemory, searchMemory];
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    return [
      {
        name: "memory",
        description: "Use long-term memory to remember facts across runs.",
        whenToUse:
          "When the user asks you to remember something, OR when they ask about something they may have told you in a prior run.",
        contentPath: join(SKILLS_DIR, "memory.md"),
      },
    ];
  },
});

export default pack;
