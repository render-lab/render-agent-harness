---
name: web-search-tavily
description: Use Tavily for fast, citation-friendly AI search.
when_to_use: When you want a concise, summarized answer with sources rather than raw search results. Tavily returns one synthesized response with citations.
---

# Web search with Tavily

Tavily returns a synthesized answer plus a small list of source URLs. It's a good fit when the user wants a direct answer that you can quote with citations, without you having to rerank raw search results.

## When to use Tavily

- The user asks a factual question that has a clear answer ("when did X ship?", "what's the current price of Y?").
- You want grounded text you can quote in your response.
- You want fewer round-trips than a search-then-fetch flow.

## When not to use Tavily

- You need many candidate URLs to compare; use a wider-recall search (e.g. Exa) instead.
- The query is exploratory ("what are the trade-offs of X vs Y") — the synthesized answer might be lossy.

## Tips

- Pass `search_depth: "advanced"` for higher-quality but slower results.
- Always include the source URLs Tavily returns when you cite a fact.
