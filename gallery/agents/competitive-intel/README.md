# Competitive intel

A weekly cron (Monday 17:00 UTC) that scrapes a list of competitor URLs, semantically diffs them against last week's snapshot in memory, and writes a memo capturing what actually changed.

**Runtimes:** cron + web (for on-demand runs from the operator UI).

**Capabilities pre-selected:** `@render-harness/cap-scrape-firecrawl` (scrape), `@render-harness/cap-search-exa` (context lookup on new product names), `@render-harness/cap-memory-pg` (snapshot store + memo history).

**Env vars:** `FIRECRAWL_API_KEY`, `EXA_API_KEY`, `COMPETITOR_URLS` (pipe-separated; supports `Label=URL` syntax).

**Use this as a starting point if:** you watch a handful of competitor sites and don't want to spend Mondays clicking through them. The agent diffs semantically (skips framework / boilerplate noise) and writes the memo only when something genuinely changed.

Memo history accumulates under `competitive-intel:<YYYY-MM-DD>:<label>` in memory — pair with a memory-aware chat agent so a human can ask "what changed at Acme over the last quarter?".
