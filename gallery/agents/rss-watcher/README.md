# RSS watcher

A cron-driven agent that polls a list of RSS/Atom feeds every 4 hours, deduplicates against memory, summarizes the substantive items, and posts the notable ones to Slack.

**Runtimes:** cron (every 4 hours) + web (for on-demand re-runs).

**Capabilities pre-selected:** `@render-harness/cap-scrape-firecrawl` (for fetching the full article body — RSS often truncates), `@render-harness/cap-slack` (read_write, `slack_send_message` HITL-gated first time), `@render-harness/cap-memory-pg` (URL-based dedup).

**Env vars:** `FIRECRAWL_API_KEY`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `FEED_URLS` (pipe-separated), `FEED_CHANNEL`.

**Use this as a starting point if:** you want curated feed-tracking instead of an RSS reader's full firehose. The system prompt sets a high "would a smart colleague read this?" bar and skips sponsored posts, roundups, and job listings by default.
