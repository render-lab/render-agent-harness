# ETL cron

A daily cron (05:00 UTC) that pulls a public dataset over HTTP, snapshots the raw payload to a Render disk via `cap-filesystem`, and writes a normalized summary to memory.

**Runtimes:** cron + web (for on-demand runs).

**Capabilities pre-selected:** `@render-harness/cap-filesystem` (path-scoped to `/var/data/etl/` — make sure the cron service has a Render disk mounted at that path) and `@render-harness/cap-memory-pg` (for the structured summary).

**Env vars:** `DATASET_URL` (public — the SSRF guard blocks loopback/private/cloud-metadata addresses by design), optional `DATASET_FORMAT` (`csv`/`json`/`jsonl`; default derived from URL extension).

**Budget:** `maxIterations: 40`, `maxCostUsd: 1`, `maxWallSeconds: 600` — tight, because ETL is mostly deterministic work.

**Use this as a starting point if:** you need a daily snapshot of an external dataset (open data portal, public API, third-party report) that you'd like normalized + queryable from memory. The agent self-rotates snapshots older than 30 days to keep the disk bounded. Pair with a chat agent for ad-hoc "what does today's dataset look like vs last week's?" queries.

This is the gallery's reference example of `cap-filesystem` — copy the manifest and adjust paths if you need filesystem persistence for a different agent type.
