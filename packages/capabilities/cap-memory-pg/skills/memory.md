---
name: memory
description: Use long-term memory to remember facts across runs.
when_to_use: When the user asks you to remember something, OR when they ask about something they may have told you in a prior run.
---

# Long-term memory

Two tools store and retrieve durable notes:

- `cap-memory-pg.write({ key, value, tags? })` — store a note. The `(namespace, key)` pair is unique; reusing a key updates the row.
- `cap-memory-pg.search({ query, limit?, tags? })` — fuzzy search by trigram similarity. Returns the top matches.

The namespace defaults to the entry name; multiple agents in the same Postgres won't collide.

## Workflow

1. Before answering, search memory for terms in the user's question.
2. If the user gives you a fact to remember (preferences, deadlines, names), write it with a stable, descriptive key.
3. Tags are optional but help filter later; suggested tags: `pref`, `decision`, `fact`, `plan`.

## Hard rules

- Never silently overwrite. If a search hit shows the user previously stated something and they're now contradicting it, surface the conflict in your reply before writing the new value.
- Keys must be stable across runs. Don't include timestamps or run ids.
- Don't store secrets, API keys, or any sensitive personal data.
