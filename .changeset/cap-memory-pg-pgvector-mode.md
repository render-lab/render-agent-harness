---
"@render-harness/cap-memory-pg": patch
---

**NEW OPT-IN: `index: pgvector` mode for embedding-based RAG.**

Existing `index: trigram` (default) behavior is unchanged — no migration needed for current users.

Opt in by setting `index: pgvector` in the pack config:

```yaml
capabilities:
  - pack: "@render-harness/cap-memory-pg"
    config:
      index: pgvector
      embeddingDim: 1536            # locks vector(N) at migration time
      chunkSize: 1000               # chars, default
      chunkOverlap: 100             # chars, default
```

Plus one of `OPENAI_API_KEY` / `VOYAGE_API_KEY` / `COHERE_API_KEY` on the service (override the auto-pick with `HARNESS_EMBEDDING_PROVIDER=openai|voyage|cohere`). Render Managed PostgreSQL ships the pgvector extension.

The pgvector mode adds three tools (mode-exclusive — trigram's `write`/`search` aren't loaded when in pgvector mode):

- `cap-memory-pg.ingest({ text, source_id?, metadata? })` — chunks, embeds, stores. Re-ingesting with the same `source_id` replaces previous chunks for that document.
- `cap-memory-pg.search({ query, k?, source_id? })` — top-K cosine-similarity search.
- `cap-memory-pg.delete({ id?, source_id?, all? })` — remove chunks.

The `agent_memory_vectors` schema is registered via the pack's new `migrations` slot (added to `CapabilityPack` in `@render-harness/registry@0.6.0`). The harness's boot-time migration runner applies it before agent code runs; the migration id encodes the configured `embeddingDim` so accidentally changing dim doesn't silently mismatch.

New skills bundle: `rag-ingestion` (loadable via `load_skill`) explains when to ingest vs search vs reach for other tools.

**Switching providers later:** the `embedding` column's dim is locked at migration time. To swap to a provider with a different dim, drop `agent_memory_vectors`, delete the matching `agent_pack_migrations` row, update `embeddingDim`, redeploy, and re-ingest. The tool surfaces an actionable error if the provider returns a vector of the wrong length.
