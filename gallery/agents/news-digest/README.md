# News digest

A daily cron (default: noon UTC) that searches a small set of topics and produces a deduped roundup of new items. Persists every URL it covers to memory so the next run skips repeats — important when most "news" agents end up summarizing the same article three days in a row.

**Runtimes:** cron + web (for on-demand re-runs from the operator UI).

**Capabilities pre-selected:** `@render-harness/cap-search-tavily` (Tavily AI search — requires `TAVILY_API_KEY`) and `@render-harness/cap-memory-pg` (for URL-based dedup).

**Env vars:** `TAVILY_API_KEY`, `DIGEST_TOPICS` (pipe-separated, e.g. `LLM evaluation|Postgres performance|edge inference`).

**Use this as a starting point if:** you want a focused topic newsletter for yourself or a team without it turning into noise. Swap to `@render-harness/cap-search-exa` if you prefer Exa's search style — the system prompt is provider-agnostic beyond the tool name.
