# @render-harness/cap-granola

## 0.7.0

### Minor Changes

- ef657b6: Initial release of `@render-harness/cap-granola`. First **API-key + polling** pack in the wave-1 family — Granola has no OAuth (the WorkOS-based flow is reverse-engineered only and not stable) and no webhooks (Granola hasn't shipped them as of 2026 Q2).

  Three read-only tools against the user's Granola account:
  - `granola.list_notes({ since?, until?, limit?, page_token? })` — paginated list of meeting notes by date range.
  - `granola.read_note({ note_id, include_transcript? })` — full transcript + structured summary + action items + attendees for one note.
  - `granola.poll_recent({ since_minutes?, k? })` — lists notes in the window, dedups against the pack-managed `granola_seen_notes` table, returns only the new ones. Use from a recurring cron run to detect new meetings without re-processing old ones.

  The `granola_seen_notes` table is created via the pack's `migrations` slot (added to `CapabilityPack` in `@render-harness/registry@0.6.0`). The harness's boot-time migration runner applies it before any tool runs — **second real consumer of the runner mechanism**, after `cap-memory-pg` pgvector mode.

  Per Q3=A from the wave-1 shipping plan, the polling primitive stays in-pack for v1. Phase 8 retro decides whether to extract `definePollingConnector` into `@render-harness/registry` based on what cap-figma and any batch-2 polling needs surface.

  Rate limits: Personal API keys are capped at 25 burst / 5 req/sec sustained per Granola docs. The pack respects `Retry-After` on 429 with one short retry, then surfaces a typed error so the agent backs off.

  Missing-key behavior mirrors `cap-search-exa`: the pack logs a `console.warn` and registers no tools when `GRANOLA_API_KEY` is unset, rather than crashing every agent in the bundle.

  Skill: `granola-notes` — picks between the three tools, explains the polling dedup semantics, lays out the canonical cap-granola + cap-notion cross-pack pattern (Granola finds the meetings, Notion records the summaries).

  Config keys:
  - `apiKeyEnv` (default `"GRANOLA_API_KEY"`) — override the env var name.
  - `keyType` (default `"personal"`) — `"personal"` or `"enterprise"`.

  Required env on the harness service:
  - `GRANOLA_API_KEY` — generate at https://app.granola.ai/settings/api-keys.

  15+ tests cover pack metadata, env schema, migration slot output (id + SQL shape), tool surfacing (3 tools when key set, 0 with warn when unset, env override), skills, `granolaFetch` (Bearer auth, query handling, 429 retry-once, 401 typed error), and `formatGranolaError` translations (401 → key rotation guidance, 429 → rate-limit + retry-after, generic → status + message passthrough).

  v1 deliberately deferred: OAuth via WorkOS (wait for Granola to ship official docs), webhooks (wait for Granola), fan-out (one-harness-run-per-new-note — `poll_recent` returns to caller for sequential processing in v1), search (Granola's `/notes` doesn't expose semantic search), write operations (Granola's API is read-only today).

### Patch Changes

- Updated dependencies [ab4dbd1]
  - @render-harness/core@0.6.1
  - @render-harness/registry@0.6.1

## 0.6.0

### Minor Changes

- Initial release. Granola.ai meeting-notes capability pack. First **API-key + polling** pack in the wave-1 family — no OAuth in v1 (Granola's official auth is bearer API keys; the WorkOS-based OAuth flow is documented only via reverse-engineering and not stable). No webhooks either; Granola hasn't shipped them.

  Surfaces:
  - Three read-only tools:
    - `granola.list_notes({ since?, until?, limit?, page_token? })` — paginated list of meeting notes by date range.
    - `granola.read_note({ note_id, include_transcript? })` — full transcript + structured summary + action items + attendees for one note.
    - `granola.poll_recent({ since_minutes?, k? })` — lists notes in the window, dedups against the pack-managed `granola_seen_notes` table, returns only the new notes. Use from a recurring cron run to detect new meetings without re-processing old ones.
  - One bundled skill (`granola-notes`) covering tool selection, polling semantics, common cross-pack patterns (Granola → Notion / Slack), and rate-limit handling.
  - One env-schema entry for `GRANOLA_API_KEY` plus an optional `GRANOLA_KEY_TYPE` for personal-vs-enterprise key selection.
  - One pack migration registered via the new `migrations` slot (added in `@render-harness/core@0.6.0`) — creates `granola_seen_notes(note_id PK, first_seen_at)` at boot. **Second real consumer of the pack-migration runner**, after `cap-memory-pg` pgvector mode.

  Polling semantics:
  - `poll_recent` lists notes in the last `since_minutes` (default 60, max 7 days), `INSERT ... ON CONFLICT DO NOTHING` on each id, returns only the freshly-inserted ones. Subsequent polls within the window see them as "already processed" and skip.
  - Per Q3=A from the wave-1 shipping plan, the polling primitive stays in-pack for v1. Phase 8 retro decides whether to extract `definePollingConnector` into `@render-harness/registry` based on what cap-figma and any batch-2 polling needs surface.
  - Fan-out (one harness run per new note) is deferred — the calling run processes the returned list sequentially.

  Rate limits: 25 burst / 5 req/sec sustained on Personal API keys. The pack respects `Retry-After` on 429 with one short retry, then surfaces a typed error so the agent backs off.

  Config keys:
  - `apiKeyEnv` (default `"GRANOLA_API_KEY"`) — override the env var name.
  - `keyType` (default `"personal"`) — `"personal"` or `"enterprise"`; affects which notes are accessible.

  Required env on the harness service:
  - `GRANOLA_API_KEY` — generate at https://app.granola.ai/settings/api-keys (Business or Enterprise plan required for Personal keys; admin-issued for Enterprise keys).

  Missing-key behavior mirrors `cap-search-exa`: the pack logs a `console.warn` and registers no tools when `GRANOLA_API_KEY` is unset, rather than crashing every agent in the bundle.
