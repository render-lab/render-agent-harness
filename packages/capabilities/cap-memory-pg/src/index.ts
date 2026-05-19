/**
 * cap-memory-pg — long-term memory backed by Postgres.
 *
 * Two indexing modes, selected via the `index` config option:
 *
 *   - `index: "trigram"` (default) — `pg_trgm` fuzzy text similarity.
 *     Two tools: `memory.write` and `memory.search`. No external
 *     dependencies beyond Postgres + `pg_trgm`. Schema is bootstrapped
 *     lazily on first tool call.
 *
 *   - `index: "pgvector"` — embedding-based retrieval for PDF/doc Q&A
 *     workflows. Three tools: `memory.ingest`, `memory.search`,
 *     `memory.delete`. Requires the `pgvector` extension on the
 *     harness Postgres (Render Managed PostgreSQL ships it). Needs
 *     one of `OPENAI_API_KEY` / `VOYAGE_API_KEY` / `COHERE_API_KEY`.
 *     Schema is registered via the pack's `migrations` slot so the
 *     boot-time runner (added in 0.6.0) applies it before tools run.
 *
 * Modes are exclusive — pick one per pack instance. To mix trigram
 * notes with vector RAG, install the pack twice with different
 * namespaces.
 *
 * Usage in render-harness.yaml:
 *
 *   capabilities:
 *     - pack: "@render-harness/cap-memory-pg"
 *       config:
 *         index: pgvector           # or "trigram" (default)
 *         namespace: "support"      # optional; default: entry.name
 *         embeddingDim: 1536        # locks the vector(N) column at migration time
 *         chunkSize: 1000           # chars per chunk (~250 tokens)
 *         chunkOverlap: 100
 *
 * **Switching modes after deploy:** the trigram schema (agent_memory)
 * and the pgvector schema (agent_memory_vectors) are separate tables;
 * switching index modes doesn't migrate data. Re-ingest into the new
 * mode if you need parity.
 *
 * **Switching providers within pgvector mode:** the `embedding`
 * column dim is locked at migration time. Re-ingestion is required if
 * you change `embeddingDim`. To clear and re-ingest, drop the table
 * and the matching `agent_pack_migrations` row, then redeploy.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPool,
  type LocalToolHandler,
  type MigrationFile,
  type SkillMetadata,
} from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };
import {
  chunkText,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  providerKeyEnv,
  selectEmbeddingProvider,
} from "./embeddings.js";

export {
  chunkText,
  DEFAULT_MODELS as EMBEDDING_PROVIDER_DEFAULTS,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  selectEmbeddingProvider,
} from "./embeddings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "skills");

type IndexMode = "trigram" | "pgvector";

interface MemoryConfig {
  namespace?: string;
  index?: IndexMode;
  embeddingDim?: number;
  embeddingProvider?: EmbeddingProviderId;
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

interface ResolvedConfig {
  namespace: string;
  index: IndexMode;
  embeddingDim: number;
  embeddingProvider?: EmbeddingProviderId;
  embeddingModel?: string;
  chunkSize: number;
  chunkOverlap: number;
}

function resolveConfig(ctx: PackContext): ResolvedConfig {
  const cfg = (ctx.config ?? {}) as MemoryConfig;
  const index: IndexMode = cfg.index === "pgvector" ? "pgvector" : "trigram";
  return {
    namespace: cfg.namespace ?? ctx.entryName,
    index,
    embeddingDim: cfg.embeddingDim ?? 1536,
    ...(cfg.embeddingProvider ? { embeddingProvider: cfg.embeddingProvider } : {}),
    ...(cfg.embeddingModel ? { embeddingModel: cfg.embeddingModel } : {}),
    chunkSize: cfg.chunkSize ?? 1000,
    chunkOverlap: cfg.chunkOverlap ?? 100,
  };
}

// --------------------------------------------------------------------
// Trigram mode (unchanged from pre-pgvector; kept for backward compat)
//
// Lazy bootstrap stays so the trigram path still works without anyone
// invoking the boot-time `applyMigrations` runner — useful for ad-hoc
// scripts and tests. Pack-level migrations are reserved for pgvector
// mode where the dim is config-locked.
// --------------------------------------------------------------------

const TRIGRAM_BOOTSTRAP_SQL = `
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

let trigramBootstrapped = false;
async function ensureTrigramSchema(): Promise<void> {
  if (trigramBootstrapped) return;
  const pool = getPool();
  await pool.query(TRIGRAM_BOOTSTRAP_SQL);
  trigramBootstrapped = true;
}

function buildTrigramTools(namespace: string): LocalToolHandler[] {
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
      await ensureTrigramSchema();
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
      await ensureTrigramSchema();
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
}

// --------------------------------------------------------------------
// pgvector mode
//
// Schema lives in a pack migration registered via the `migrations`
// slot. The dim is config-driven so the migration's vector(N) column
// matches whichever embedding provider the operator wired up.
// --------------------------------------------------------------------

function pgvectorMigrationSql(dim: number): string {
  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_memory_vectors (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  source_id TEXT,
  chunk_index INT NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(${dim}) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_memory_vectors_ns_idx
  ON agent_memory_vectors (namespace);

CREATE INDEX IF NOT EXISTS agent_memory_vectors_source_idx
  ON agent_memory_vectors (namespace, source_id);

-- ivfflat with cosine distance; lists = ceil(sqrt(rows)) is the rule
-- of thumb. 100 is a sensible starting point for <10k chunks. For
-- larger corpora, REINDEX with a higher 'lists' parameter.
CREATE INDEX IF NOT EXISTS agent_memory_vectors_embedding_idx
  ON agent_memory_vectors USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
`;
}

function vectorLiteral(values: number[]): string {
  // pgvector accepts a literal of the form '[1.0,2.0,...]' on either
  // INSERT or SELECT. Build it as a string so we don't depend on a
  // pg-side serializer.
  return `[${values.map((v) => Number(v).toString()).join(",")}]`;
}

function buildPgvectorTools(
  cfg: ResolvedConfig,
  envFn: (name: string) => string | undefined,
): LocalToolHandler[] {
  // Provider selection is deferred to first call so the pack can boot
  // (and its skills + migration can register) even without a key set.
  // The tool returns an actionable error when the key is missing.
  let resolvedProvider: EmbeddingProvider | null | undefined;
  const provider = (): EmbeddingProvider | null => {
    if (resolvedProvider !== undefined) return resolvedProvider;
    resolvedProvider = selectEmbeddingProvider({
      env: envFn,
      ...(cfg.embeddingProvider ? { preferred: cfg.embeddingProvider } : {}),
      ...(cfg.embeddingModel ? { model: cfg.embeddingModel } : {}),
    });
    return resolvedProvider;
  };

  const noProviderError = (toolName: string) => ({
    content:
      `${toolName}: no embedding provider configured. Set one of OPENAI_API_KEY / ` +
      `VOYAGE_API_KEY / COHERE_API_KEY on the harness service (or override with ` +
      `HARNESS_EMBEDDING_PROVIDER + the matching key).`,
    isError: true,
  });

  const dimMismatchError = (toolName: string, got: number) => ({
    content:
      `${toolName}: embedding provider returned vectors of length ${got}, but the pack's ` +
      `agent_memory_vectors column is locked at vector(${cfg.embeddingDim}) by config. ` +
      `Set embeddingDim: ${got} in render-harness.yaml AND drop the existing table ` +
      `(DROP TABLE agent_memory_vectors; DELETE FROM agent_pack_migrations WHERE pack_name = 'cap-memory-pg') ` +
      `before redeploying.`,
    isError: true,
  });

  const ingest: LocalToolHandler = {
    definition: {
      name: "ingest",
      description:
        "Chunk, embed, and store a piece of text for later semantic search. Use for ingesting documents, transcripts, or any reference material you want to query later with memory.search. Each call replaces previous chunks with the same source_id; pass distinct source_ids for distinct documents.",
      source: "pack:cap-memory-pg",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: {
            type: "string",
            description: "Document text to ingest.",
            minLength: 1,
          },
          source_id: {
            type: "string",
            description:
              "Stable id for the source document. Re-ingesting with the same source_id replaces its chunks.",
            maxLength: 256,
          },
          metadata: {
            type: "object",
            description: "Optional JSON metadata attached to every chunk (title, URL, etc.).",
            additionalProperties: true,
          },
        },
        required: ["text"],
      },
    },
    async handler({ input }) {
      const args = (input ?? {}) as {
        text?: string;
        source_id?: string;
        metadata?: Record<string, unknown>;
      };
      if (!args.text) return { content: "memory.ingest: text is required", isError: true };
      const prov = provider();
      if (!prov) return noProviderError("memory.ingest");

      const chunks = chunkText(args.text, {
        size: cfg.chunkSize,
        overlap: cfg.chunkOverlap,
      });
      if (chunks.length === 0) {
        return { content: "memory.ingest: no chunks produced (input was empty after trim)" };
      }

      let vectors: number[][];
      try {
        vectors = await prov.embed(chunks);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `memory.ingest: embedding call failed — ${msg}`, isError: true };
      }
      if (vectors.length !== chunks.length) {
        return {
          content: `memory.ingest: provider returned ${vectors.length} vectors for ${chunks.length} chunks (expected match)`,
          isError: true,
        };
      }
      if (vectors[0] && vectors[0].length !== cfg.embeddingDim) {
        return dimMismatchError("memory.ingest", vectors[0].length);
      }

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (args.source_id) {
          await client.query(
            "DELETE FROM agent_memory_vectors WHERE namespace = $1 AND source_id = $2",
            [cfg.namespace, args.source_id],
          );
        }
        const metaJson = JSON.stringify(args.metadata ?? {});
        for (let i = 0; i < chunks.length; i++) {
          const v = vectors[i];
          if (!v) continue;
          await client.query(
            `INSERT INTO agent_memory_vectors
               (namespace, source_id, chunk_index, content, metadata, embedding)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)`,
            [cfg.namespace, args.source_id ?? null, i, chunks[i] ?? "", metaJson, vectorLiteral(v)],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `memory.ingest: insert failed — ${msg}`, isError: true };
      } finally {
        client.release();
      }
      return {
        content: `memory.ingest: stored ${chunks.length} chunks (provider=${prov.id}, model=${prov.model}, dim=${cfg.embeddingDim})${args.source_id ? ` for source_id="${args.source_id}"` : ""}.`,
      };
    },
  };

  const search: LocalToolHandler = {
    definition: {
      name: "search",
      description:
        "Semantic-search ingested chunks for a query. Returns the top-k most similar chunks (cosine distance). Use this when the user asks about content you previously ingested with memory.ingest.",
      source: "pack:cap-memory-pg",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Search query.", minLength: 1 },
          k: {
            type: "integer",
            description: "Top-K results. Default 5, max 25.",
            minimum: 1,
            maximum: 25,
          },
          source_id: {
            type: "string",
            description: "Optional: restrict search to chunks from this source_id.",
          },
        },
        required: ["query"],
      },
    },
    async handler({ input }) {
      const args = (input ?? {}) as { query?: string; k?: number; source_id?: string };
      if (!args.query) return { content: "memory.search: query is required", isError: true };
      const prov = provider();
      if (!prov) return noProviderError("memory.search");

      let queryVec: number[][];
      try {
        queryVec = await prov.embed([args.query]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `memory.search: embedding call failed — ${msg}`, isError: true };
      }
      const v = queryVec[0];
      if (!v) return { content: "memory.search: provider returned no embedding", isError: true };
      if (v.length !== cfg.embeddingDim) {
        return dimMismatchError("memory.search", v.length);
      }

      const k = Math.min(args.k ?? 5, 25);
      const pool = getPool();
      const rows = await pool.query<{
        id: string;
        source_id: string | null;
        chunk_index: number;
        content: string;
        metadata: Record<string, unknown>;
        distance: number;
      }>(
        `SELECT id, source_id, chunk_index, content, metadata,
                (embedding <=> $2::vector) AS distance
         FROM agent_memory_vectors
         WHERE namespace = $1
           AND ($3::text IS NULL OR source_id = $3)
         ORDER BY embedding <=> $2::vector
         LIMIT $4`,
        [cfg.namespace, vectorLiteral(v), args.source_id ?? null, k],
      );
      if (rows.rows.length === 0) {
        return {
          content: `memory.search: no chunks ingested yet in namespace "${cfg.namespace}"`,
        };
      }
      const lines = rows.rows.map((r, i) => {
        const score = (1 - r.distance).toFixed(3);
        const src = r.source_id ? `source=${r.source_id}#${r.chunk_index}` : `id=${r.id}`;
        return `${i + 1}. (${src}, similarity=${score})\n   ${r.content.slice(0, 600)}`;
      });
      return { content: lines.join("\n\n") };
    },
  };

  const del: LocalToolHandler = {
    definition: {
      name: "delete",
      description:
        "Delete ingested chunks by id, source_id, or namespace. Useful when the underlying document changes or when you want to clear test data.",
      source: "pack:cap-memory-pg",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer", description: "Delete one chunk by primary key." },
          source_id: {
            type: "string",
            description: "Delete all chunks for this source_id (within the pack's namespace).",
          },
          all: {
            type: "boolean",
            description:
              "Delete EVERY chunk in the pack's namespace. Set explicitly; ignored otherwise.",
          },
        },
      },
    },
    async handler({ input }) {
      const args = (input ?? {}) as { id?: number; source_id?: string; all?: boolean };
      if (!args.id && !args.source_id && args.all !== true) {
        return {
          content: "memory.delete: provide one of {id, source_id, all: true}",
          isError: true,
        };
      }
      const pool = getPool();
      let res: { rowCount: number | null };
      if (args.id) {
        res = await pool.query(
          "DELETE FROM agent_memory_vectors WHERE namespace = $1 AND id = $2",
          [cfg.namespace, args.id],
        );
      } else if (args.source_id) {
        res = await pool.query(
          "DELETE FROM agent_memory_vectors WHERE namespace = $1 AND source_id = $2",
          [cfg.namespace, args.source_id],
        );
      } else {
        res = await pool.query("DELETE FROM agent_memory_vectors WHERE namespace = $1", [
          cfg.namespace,
        ]);
      }
      return { content: `memory.delete: removed ${res.rowCount ?? 0} chunk(s)` };
    },
  };

  return [ingest, search, del];
}

// --------------------------------------------------------------------
// Pack definition
// --------------------------------------------------------------------

const pack = definePack({
  name: "cap-memory-pg",
  version: pkg.version,
  envSchema: [
    {
      name: "OPENAI_API_KEY",
      required: false,
      secret: true,
      description:
        "At least one of OPENAI_API_KEY / VOYAGE_API_KEY / COHERE_API_KEY is required when index: pgvector. Pre-selected in that order via HARNESS_EMBEDDING_PROVIDER if multiple are set.",
    },
    {
      name: "VOYAGE_API_KEY",
      required: false,
      secret: true,
      description: "Embedding provider alternative to OpenAI (voyage-3-lite, 1024 dims).",
    },
    {
      name: "COHERE_API_KEY",
      required: false,
      secret: true,
      description: "Embedding provider alternative to OpenAI (embed-v3, 1024 dims).",
    },
    {
      name: "HARNESS_EMBEDDING_PROVIDER",
      required: false,
      secret: false,
      description:
        "Override the auto-selected embedding provider (openai|voyage|cohere). Useful when multiple keys are set.",
    },
  ],
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = resolveConfig(ctx);
    if (cfg.index === "pgvector") {
      return buildPgvectorTools(cfg, ctx.env);
    }
    return buildTrigramTools(cfg.namespace);
  },
  migrations(ctx: PackContext): MigrationFile[] {
    const cfg = resolveConfig(ctx);
    if (cfg.index !== "pgvector") return [];
    // The id includes the dim so the runner treats a dim change as a
    // distinct migration. This won't actually re-shape an existing
    // table (the SQL only CREATEs IF NOT EXISTS) — see the README's
    // "Switching providers" note for the manual drop+rerun flow when
    // operators truly need a different dim. The id-with-dim is
    // belt-and-suspenders so a sneaky dim change doesn't silently
    // mismatch.
    return [
      {
        id: `0001_pgvector_d${cfg.embeddingDim}`,
        sql: pgvectorMigrationSql(cfg.embeddingDim),
      },
    ];
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
      {
        name: "rag-ingestion",
        description:
          "Chunk, embed, and search documents for retrieval-augmented Q&A. Available when the pack is configured with index: pgvector.",
        whenToUse:
          "When the user gives you a document, URL, or transcript to remember for later questions, or asks you to answer based on previously-ingested material.",
        contentPath: join(SKILLS_DIR, "rag-ingestion.md"),
      },
    ];
  },
});

export default pack;

// Surface a typed re-export of the env helper for tests + downstream
// tooling that wants to introspect which provider would be picked
// given a particular env.
export function defaultEmbeddingProviderKeyEnv(id: EmbeddingProviderId): string {
  return providerKeyEnv(id);
}
