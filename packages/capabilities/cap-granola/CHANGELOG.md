# @render-harness/cap-granola

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
