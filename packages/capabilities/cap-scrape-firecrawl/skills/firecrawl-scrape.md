---
name: firecrawl-scrape
description: Use Firecrawl to render a URL into clean markdown and store it.
when_to_use: When the user gives you a URL whose content you'll need later in the run, OR you've already searched and want to read the top result. Prefer scrape_and_store over the raw MCP tool when persistence matters.
---

# Scraping with Firecrawl

Two ways to use Firecrawl from this entry:

1. The `cap-scrape-firecrawl.firecrawl` MCP — exposes Firecrawl's full tool set: `firecrawl_scrape`, `firecrawl_crawl`, `firecrawl_search`, etc. Use this for one-off lookups whose output you don't need to revisit.

2. The `scrape_and_store` local tool — same scrape semantics, but the rendered markdown + raw JSON are inserted into Postgres (`firecrawl_scrapes` table) keyed on `(run_id, url)`. The tool returns the row id plus a 1k-character excerpt. Use this when you'll come back to the page later in the run, or when you want a durable record of what you saw.

## When to use scrape_and_store vs the MCP

- The page is large (>~5k tokens) and you only need an excerpt now: scrape_and_store; later, query the row id directly.
- You're scraping many pages: scrape_and_store gives you a stable row id you can reference instead of re-passing the markdown through the context.
- Quick one-shot answer where you'll never come back: use the MCP.

## Hard rules

- Always prefer the page's canonical URL over a query-string variant. The unique constraint is on `(run_id, url)`.
- If a scrape fails, surface the error in your final answer; don't keep retrying with the same URL.
