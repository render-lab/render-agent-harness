# @render-harness/cap-memory-pg

Postgres-backed long-term memory for any harness entry. Two indexing modes:

- **`index: "trigram"` (default)** — fuzzy text similarity via `pg_trgm`. Two tools (`memory.write`, `memory.search`). No external dependencies beyond Postgres. Best for "remember this fact" workflows.
- **`index: "pgvector"`** — embedding-based RAG via the `pgvector` extension. Three tools (`memory.ingest`, `memory.search`, `memory.delete`). Requires one of `OPENAI_API_KEY` / `VOYAGE_API_KEY` / `COHERE_API_KEY`. Best for "answer questions about this document I gave you" workflows.

Modes are exclusive — pick one per pack instance. To mix trigram notes with vector RAG in the same agent, install the pack twice with different namespaces.

## Install

```sh
pnpm add @render-harness/cap-memory-pg
```

## Trigram mode (default)

```yaml
capabilities:
  - pack: "@render-harness/cap-memory-pg"
    config:
      namespace: my-agent   # optional; defaults to the entry name
```

Contributes:

- `cap-memory-pg.write({ key, value, tags? })` — durable upsert keyed on `(namespace, key)`.
- `cap-memory-pg.search({ query, limit?, tags? })` — trigram fuzzy search.
- A skill (`memory`) telling the agent when to use these tools.

Schema (`agent_memory` table + `pg_trgm` extension + GIN indexes) is bootstrapped lazily on first call. No env vars required beyond the existing `DATABASE_URL`.

## pgvector mode

```yaml
capabilities:
  - pack: "@render-harness/cap-memory-pg"
    config:
      index: pgvector
      namespace: support             # optional
      embeddingDim: 1536             # locks the vector(N) column
      embeddingProvider: openai      # optional; auto-picked from env if unset
      embeddingModel: text-embedding-3-small  # optional; provider default if unset
      chunkSize: 1000                # chars (~250 tokens), default 1000
      chunkOverlap: 100              # chars (~25 tokens), default 100
```

Set one of:

```sh
OPENAI_API_KEY=sk_...    # default; text-embedding-3-small, 1536 dims
VOYAGE_API_KEY=vk_...    # voyage-3-lite, 1024 dims
COHERE_API_KEY=co_...    # embed-v3, 1024 dims
# Optional override when multiple are set:
HARNESS_EMBEDDING_PROVIDER=voyage
```

Contributes:

- `cap-memory-pg.ingest({ text, source_id?, metadata? })` — chunks, embeds, stores. Re-ingesting with the same `source_id` replaces previous chunks for that document.
- `cap-memory-pg.search({ query, k?, source_id? })` — top-K vector similarity (cosine distance).
- `cap-memory-pg.delete({ id?, source_id?, all? })` — remove chunks.
- A skill (`rag-ingestion`) explaining when to ingest vs search vs use other tools.

Schema (`agent_memory_vectors` table + pgvector extension + ivfflat index) is registered via the pack's `migrations` slot. The harness's boot-time migration runner (added in `@render-harness/core@0.6.0`) applies it before agent code runs. Render Managed PostgreSQL ships pgvector; verify with `psql -c '\dx vector'` if you're self-hosting.

### Switching embedding providers (or dims)

The `embedding` column's dim is locked at migration time. To swap to a provider with a different dim:

1. Drop the existing table:
   ```sql
   DROP TABLE agent_memory_vectors;
   DELETE FROM agent_pack_migrations
     WHERE pack_name = 'cap-memory-pg' AND migration_id LIKE '0001_pgvector_d%';
   ```
2. Update `embeddingDim` (and `embeddingProvider` / `embeddingModel`) in `render-harness.yaml`.
3. Redeploy. The runner applies a new migration matching the new dim.
4. Re-ingest your corpus.

If you forget to drop the table, `memory.ingest` and `memory.search` surface an actionable error pointing at this flow.

### Index tuning

The default ivfflat index uses `lists = 100`, which is fine up to ~10k chunks. For larger corpora, reindex with `lists ≈ ceil(sqrt(rows))`:

```sql
DROP INDEX agent_memory_vectors_embedding_idx;
CREATE INDEX agent_memory_vectors_embedding_idx
  ON agent_memory_vectors USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 1000);
```

## Versioning

Trigram mode is unchanged from earlier versions. pgvector mode was added as a new opt-in surface in `0.6.0` (no breaking change for existing trigram users; default behavior is unchanged). See `docs/AGENTS.md` for the family-wide versioning model.
