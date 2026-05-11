# Research cron

A cron-runtime agent that runs on a schedule (default: daily at 13:00 UTC) and performs research using Exa web search.

**Runtime:** cron only — single-shot, long-running. Each invocation has up to 11 hours of wall time (cron runtime budget) before the platform's 12-hour kill.

**Capabilities pre-selected:** `@render-harness/cap-search-exa` (requires `EXA_API_KEY`).

**Use this as a starting point if:** you want a long-running scheduled agent that produces a daily/hourly report — research summaries, monitoring digests, citation audits. Swap the schedule expression in `render-harness.yaml` to fit your cadence.
