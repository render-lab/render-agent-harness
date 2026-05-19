---
name: granola-notes
description: List and read Granola meeting notes; use poll_recent on a cron schedule to detect new meetings.
when_to_use: When the user asks about a meeting, asks you to summarize recent meetings, or when this run was kicked off by a recurring cron to ingest new notes.
---

# Granola meeting notes

The cap-granola pack exposes three tools against the Granola.ai API:

- `granola.list_notes({ since?, until?, limit?, page_token? })` — paginated list of notes by date range. Returns id, title, when, attendees, short summary per note.
- `granola.read_note({ note_id, include_transcript? })` — full transcript + structured summary + action items + attendees for one note.
- `granola.poll_recent({ since_minutes?, k? })` — list notes in the last window, dedup against the harness's `granola_seen_notes` table, return only the new ones.

## Picking the right tool

- **User asks "what did we cover in last week's standup?"** → `list_notes({ since: "...", until: "..." })`, find the one by title, then `read_note(id)`.
- **User asks "summarize my meeting with Alice yesterday"** → `list_notes` filtered by date, find the right one by attendees, then `read_note`.
- **Recurring cron run, "process new meetings as they finish"** → `poll_recent({ since_minutes: 60 })`. Returns just the meetings the harness hasn't seen before. For each, decide what to do (write a Notion page, drop a Slack summary, etc.).

## poll_recent semantics

The seen-notes table is created automatically by the harness's pack-migration runner on the first boot after installing cap-granola. Each call to `poll_recent`:

1. Lists notes finished in the last `since_minutes` (default 60, max 7 days).
2. Inserts each note id into `granola_seen_notes` with `ON CONFLICT DO NOTHING`.
3. Returns only the rows whose insert actually fired — i.e. notes the harness saw for the first time on this call.

If the cron didn't fire for a while, set `since_minutes` to cover the gap. If a meeting was processed but you want to re-process it, manually delete its row from `granola_seen_notes` (the operator can `pnpm db:psql` and `DELETE FROM granola_seen_notes WHERE note_id = '...'`).

## Combine with cap-notion (or anywhere else)

Common pattern: poll Granola → for each new note, summarize → write to Notion. Example flow:

```
1. poll_recent({ since_minutes: 60 })          → returns 2 new notes
2. read_note({ note_id: <first id> })          → full content
3. notion.create_page({ parent_database_id: "...", properties: { ... } })
4. read_note({ note_id: <second id> })
5. notion.create_page(...)
```

This is the canonical wave-1 cross-pack validation: cap-granola finds the work, cap-notion records it.

## Rate limits

Personal API keys are capped at **25 burst / 5 req/sec sustained**. The pack respects `Retry-After` on 429 with one short retry, then surfaces the rate-limit error to you. If you see one, back off — call `read_note` for each new note one at a time, with a small pause between batches.

## What this skill doesn't cover

- **OAuth.** Granola has a reverse-engineered OAuth flow via WorkOS but no official documentation. cap-granola v1 uses bearer API keys only.
- **Webhooks.** Granola hasn't shipped webhook support. Polling is the only option.
- **Search.** The `/notes` endpoint doesn't expose semantic search; use date filtering + the title/attendees in the list output to narrow down.
- **Write operations.** Granola's public API is read-only at the time of writing.
