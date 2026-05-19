# Chat with memory

The natural next step from the `chat` starter: same HTTP chat shape, but with `@render-harness/cap-memory-pg` wired in so the model can recall details across conversations.

**Runtimes:** web + worker. The web service accepts chat turns at `/runs`; the worker drains the queue and runs each turn through the harness loop.

**Capabilities pre-selected:** `@render-harness/cap-memory-pg` (uses the harness's Postgres — no extra service needed).

**Use this as a starting point if:** you want a chat assistant that learns about its user over time — preferences, ongoing projects, decisions made. The system prompt instructs the model to search memory before answering and write durable notes after learning something new.

The operator UI is mounted by default at `/ui` — sign-in flow is per-end-user (see [docs-site/src/content/docs/connections-api.mdx](../../../docs-site/src/content/docs/connections-api.mdx)) so each user gets their own memory namespace via the conversation key.
