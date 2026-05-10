---
name: web-search-exa
description: Use Exa for high-recall, neural web search.
when_to_use: When you need fresh web context, comparison shopping, or to find specific facts not in your training data. Prefer this over fetch_url unless you already have a specific URL.
---

# Web search with Exa

Exa is a neural search engine optimized for high-recall retrieval over the open web. The `cap-search-exa.exa` MCP exposes Exa's tool set; the most useful tools are:

- `web_search_exa` — returns ranked results for a free-form query, with title, URL, and a relevance-scored snippet.
- `crawl_url` — fetches the body of a single page.

## When to use Exa

- The user asks about something time-sensitive (current pricing, recent releases, announcements).
- You need a citation or a quote from a specific source.
- You're trying to find a project, library, or company by description.

## When not to use Exa

- The user is asking about their own Render account — use the Render MCP instead.
- You already have the exact URL — use `crawl_url` directly.
- The question is conceptual and doesn't need a fresh source.

## Tips

- Keep queries short and specific; Exa is neural, so concept-style queries work well.
- If you want results from a specific time window, set the `startPublishedDate` argument.
- Always cite the URL you used in your final answer.
