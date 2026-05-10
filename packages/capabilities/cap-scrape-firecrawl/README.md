## @render-harness/cap-scrape-firecrawl

Wires Firecrawl into a Render harness entry, with optional Postgres persistence:

```yaml
capabilities:
  - pack: "@render-harness/cap-scrape-firecrawl"
    config:
      persist: true   # default
```

Set `FIRECRAWL_API_KEY` in the entry's environment.

The pack contributes:

- An MCP server `cap-scrape-firecrawl.firecrawl` (stdio transport, runs `npx -y firecrawl-mcp`).
- A `LocalToolHandler` `cap-scrape-firecrawl.scrape_and_store` that calls Firecrawl's REST API and persists the rendered markdown to a `firecrawl_scrapes` table.
- A skill (`firecrawl-scrape`).
- A `FIRECRAWL_API_KEY` entry in the effective env schema.

The Postgres table is created on first call via `CREATE TABLE IF NOT EXISTS`, so no separate migration step is needed.
