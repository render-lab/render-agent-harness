# @render-harness/cap-granola

Granola.ai meeting-notes capability pack for the [Render Agent Harness](https://github.com/render-lab/render-agent-harness). First **API-key + polling** pack in the wave-1 family:

- **No OAuth** — Granola's official auth is bearer API keys (Personal or Enterprise).
- **No webhooks** — Granola hasn't shipped them; cap-granola polls instead.
- **In-pack polling** — `granola.poll_recent` lists notes finished in the last window, dedups against a pack-managed table (`granola_seen_notes`, created at boot via the new pack-level migration runner in `@render-harness/core@0.6.0`), and returns only the new ones.

## Install

```sh
pnpm add @render-harness/cap-granola
```

## Configure

```yaml
capabilities:
  - pack: "@render-harness/cap-granola"
    config:
      keyType: personal           # or "enterprise"; default "personal"
      apiKeyEnv: GRANOLA_API_KEY  # default

agents:
  - id: meeting-notes-cron
    runtimes:
      - kind: cron
        schedule: "*/15 * * * *"  # poll every 15 minutes
    # ... agent calls granola.poll_recent + acts on new notes
```

Set the API key on the harness service:

```sh
GRANOLA_API_KEY=<get one at https://app.granola.ai/settings/api-keys>
```

Personal API keys are Beta and require a Business or Enterprise Granola plan. Enterprise API keys are minted by workspace admins for org-wide access (set `keyType: enterprise` on the pack config).

## Tools

All read-only against the user's Granola account:

| Tool | When to use |
|---|---|
| `granola.list_notes` | Paginated list by date range. Returns id, title, when, attendees, short summary per note. |
| `granola.read_note` | Full transcript + structured summary + action items + attendees for one note. |
| `granola.poll_recent` | Detects new meetings since the last poll. Dedups against `granola_seen_notes`. Returns just the new notes. Pair with a recurring cron run. |

## Polling primitive

`granola.poll_recent`:

1. Lists notes finished in the last `since_minutes` (default 60, max 7 days).
2. Inserts each note id into `granola_seen_notes` with `ON CONFLICT DO NOTHING`.
3. Returns only the notes whose insert actually fired.

The `granola_seen_notes` table is created automatically by the harness's pack-migration runner on the first boot after installing cap-granola — no manual `psql` step required. (This is the second real consumer of the runner mechanism, after `cap-memory-pg` pgvector mode.)

For "process new meetings as they land" workflows:

```yaml
agents:
  - id: meeting-notes-cron
    agent:
      kind: builtin
      ref: chat
      systemPrompt: |
        Every 15 minutes, call granola.poll_recent({ since_minutes: 20 }).
        For each new note, call granola.read_note and write a one-paragraph
        summary to Notion in the "Meetings 2026" database.
    runtimes:
      - kind: cron
        schedule: "*/15 * * * *"
    capabilities: []   # cap-granola declared at bundle level above
```

The shipping plan's recommended pairing is cap-granola + cap-notion — Granola finds the work, Notion records it.

## Rate limits

Per Granola docs (Personal API keys): 25 burst, 5 req/sec sustained. The pack respects `Retry-After` on 429 with one short retry, then surfaces the error to the agent so it can back off.

## v1 limitations

- **No OAuth** — Granola has a WorkOS-based OAuth flow but it's documented only via reverse-engineering and not stable. v1 ships API-key auth only.
- **No webhooks** — Granola hasn't shipped them. Polling is the only option for new-note detection.
- **No fan-out** — `poll_recent` returns new notes to the calling run; the run processes them sequentially. One-harness-run-per-new-note fan-out is a v2 platform decision (tracked in the wave-1 retro).
- **No search** — Granola's `/notes` doesn't expose semantic search. Use date filtering + list titles/attendees to narrow down.
- **Read-only** — Granola's public API has no write endpoints today.

## Skill

`granola-notes` (loadable via `load_skill`) — picking between the three tools, the `poll_recent` dedup semantics, common cross-pack patterns (Granola → Notion / Slack), rate-limit handling.

## Versioning

First release at `0.6.0` matching the family minor. See `docs/AGENTS.md` for the family-wide versioning model.
