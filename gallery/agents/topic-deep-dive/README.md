# Topic deep dive

A workflows-mode research agent. Takes a topic as task input, drafts a section outline (HITL — you approve before deep research starts), then produces a multi-section markdown report grounded in scraped sources.

**Runtime:** workflows only. Each run is durable, observable in the Render Workflows UI, and pauses cleanly on the `ask_user` outline-confirmation gate.

**Capabilities pre-selected:** `@render-harness/cap-search-exa` (initial survey + per-section search), `@render-harness/cap-scrape-firecrawl` (full-text scraping for grounding), `@render-harness/cap-memory-pg` (storing the finished report).

**Env vars:** `EXA_API_KEY`, `FIRECRAWL_API_KEY`.

**Budget:** `maxIterations: 80`, `maxCostUsd: 3`, `maxWallSeconds: 1800` — tight enough that a runaway run won't melt the API budget.

**Use this as a starting point if:** you want a "give me a deep report on X" agent that doesn't hallucinate sources. The HITL outline gate means you spend 30 seconds reviewing the angle before the agent burns 5-10 minutes of scraping + writing. Pair with a chat agent that triggers this workflow via `trigger_workflow` so users can ask "do a deep dive on Postgres connection pooling at scale" from chat.
