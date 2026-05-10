## @render-harness/cap-memory-pg

Postgres-backed long-term memory for any harness entry:

```yaml
capabilities:
  - pack: "@render-harness/cap-memory-pg"
    config:
      namespace: my-agent   # optional; defaults to the entry name
```

The pack contributes:

- `cap-memory-pg.write({ key, value, tags? })` — durable upsert keyed on `(namespace, key)`.
- `cap-memory-pg.search({ query, limit?, tags? })` — trigram fuzzy search.
- A skill (`memory`) telling the agent when to use these tools.

The Postgres schema (an `agent_memory` table + `pg_trgm` extension + GIN indexes) is bootstrapped lazily on first call. No env vars required — the pack uses the existing `DATABASE_URL` that every harness service already has.
