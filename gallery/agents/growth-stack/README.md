# Growth stack

A bundle for content + growth teams that combines daily/weekly recon agents with an on-demand deep-research workflow.

| Agent | Trigger | What it does |
|---|---|---|
| `growth-chat` | Web + worker | Chat front-end. Reads memory for digests + memos; triggers deep dives on demand (HITL-gated). |
| `news-digest` | Daily 12:00 UTC | Topic-scoped news roundup using Tavily; URL-dedup via memory. |
| `competitive-intel` | Monday 17:00 UTC | Scrapes competitor URLs via Firecrawl; semantic diff vs last week's snapshot. |
| `topic-deep-dive` | Workflow task (on demand from chat) | Multi-section report grounded in Exa + Firecrawl; HITL on the outline. |

All four share `cap-search-exa`, `cap-search-tavily`, `cap-scrape-firecrawl`, and `cap-memory-pg`. Memory accumulates so the chat agent can answer "what's changed at Acme this quarter?" or "give me the news-digest highlights from last week".

## Deploys to

- 1 web service (chat surface + operator UI)
- 1 worker pserv (drains chat queue)
- 2 Render Cron services (news-digest, competitive-intel)
- 1 Render Workflow service hosting `topic-deep-dive`
- 1 Postgres + 1 Key Value

## Env vars

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Auto-added. |
| `EXA_API_KEY` | yes | Competitive-intel + topic-deep-dive search. |
| `TAVILY_API_KEY` | yes | News-digest search. |
| `FIRECRAWL_API_KEY` | yes | Competitive-intel + topic-deep-dive scraping. |
| `DIGEST_TOPICS` | yes | Pipe-separated topics for news-digest. |
| `COMPETITOR_URLS` | yes | Pipe-separated competitor URLs (supports `Label=URL`). |
| `RENDER_API_KEY` | yes | Required for the Workflow service that hosts `topic-deep-dive`. |

## Use this as a starting point if

You want a content/growth-research stack that combines automated recon (daily news + weekly competitor diffs) with on-demand depth (deep-dive workflows triggered from chat). Each agent in the bundle also exists as a standalone atomic entry (`news-digest`, `competitive-intel`, `topic-deep-dive`) — pick the subset you need if a full bundle is too much.
