---
name: rag-ingestion
description: Chunk, embed, and search documents for retrieval-augmented Q&A. Available when the pack is configured with index: pgvector.
when_to_use: When the user gives you a document, URL, or transcript to remember for later questions, or asks you to answer based on previously-ingested material.
---

# RAG with cap-memory-pg pgvector mode

When the pack is configured with `index: pgvector` it exposes three tools that together let you do retrieval-augmented Q&A over arbitrary text:

- `memory.ingest({ text, source_id?, metadata? })` — chunks the text, embeds each chunk with the configured provider (OpenAI / Voyage / Cohere), and stores them.
- `memory.search({ query, k?, source_id? })` — embeds the query, returns the top-K most similar chunks (cosine distance).
- `memory.delete({ id?, source_id?, all? })` — removes chunks.

## When to ingest

- The user pasted a document body or a URL whose contents you fetched.
- You loaded a transcript / meeting notes / wiki page that's worth keeping for follow-ups.
- The user uploaded a file and asked you to "remember it for later".

Pass a stable `source_id` per document — re-ingesting with the same `source_id` replaces the previous chunks for that document. That's the cleanest way to refresh a doc that changed.

Add `metadata` (an object) when you want to track URL, title, ingestion date, or any other field you might want at search time. The metadata round-trips on every search result.

## When to search

- The user asks something that might be answered by content you ingested earlier in the conversation OR by another agent in the same bundle (they share the namespace).
- Before fabricating a citation: `memory.search` first, cite the matching chunk.

Pick a small `k` (default 5) unless the query is broad — too many results crowd the context.

## When not to use this

- The user wants to remember a single fact ("my birthday is March 4"). That's better served by the **trigram** mode of this pack (`memory.write` / `memory.search`) or `todo` for in-run notes.
- Real-time fetches of fresh web content — use `fetch_url` or `web_search` instead. RAG is for content you can ingest once and query many times.

## Chunking

Chunks are character-based (~4 chars per token in English). Defaults:

- `chunkSize: 1000` chars (~250 tokens).
- `chunkOverlap: 100` chars (~25 tokens).

Override per-pack in `render-harness.yaml` if you ingest unusually-shaped content (very short Q&A pairs → smaller chunks; long-form articles → larger). The splitter prefers paragraph then sentence then word boundaries to avoid cutting mid-token where possible.

## Switching providers

The pack embeds with whichever of `OPENAI_API_KEY` / `VOYAGE_API_KEY` / `COHERE_API_KEY` is set (override with `HARNESS_EMBEDDING_PROVIDER`). The pgvector column dim is locked at migration time; switching to a provider with a different output dim (e.g. OpenAI 1536 → Voyage 1024) requires re-ingesting your corpus.

If `memory.ingest` or `memory.search` returns an actionable error about a dim mismatch, follow the steps in the message: drop the existing `agent_memory_vectors` table, delete the matching `agent_pack_migrations` row, set the new `embeddingDim` in `render-harness.yaml`, redeploy, then re-ingest.
