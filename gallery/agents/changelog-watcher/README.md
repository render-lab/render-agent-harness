# Changelog watcher

A weekly cron (Monday 18:00 UTC) that scrapes a list of vendor changelog pages, diffs against last week's snapshot, and writes a "what changed in our stack" memo into memory.

**Runtimes:** cron + web (for on-demand re-runs).

**Capabilities pre-selected:** `@render-harness/cap-scrape-firecrawl` (for clean markdown extraction from any changelog page) and `@render-harness/cap-memory-pg` (snapshot + memo store).

**Env vars:** `FIRECRAWL_API_KEY`, `CHANGELOG_URLS` (pipe-separated; supports `Vendor=URL` syntax).

**Use this as a starting point if:** your team depends on a half-dozen vendors with active changelogs and "did anything new ship at <vendor>?" comes up every sprint. The agent only writes a memo when something actually changed and explicitly skips typo-fix-grade entries. Memos accumulate in memory under `changelog-memo:*` keys, so a memory-aware chat agent can answer "what's new at OpenAI this quarter?".
