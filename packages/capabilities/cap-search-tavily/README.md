## @render-harness/cap-search-tavily

Wires Tavily AI search into a Render harness entry. Drop into `render-harness.yaml`:

```yaml
capabilities:
  - pack: "@render-harness/cap-search-tavily"
```

Set `TAVILY_API_KEY` in the entry's environment.

The pack contributes:

- An MCP server `cap-search-tavily.tavily` (stdio transport, runs `npx -y tavily-mcp`).
- A skill (`web-search-tavily`).
- A `TAVILY_API_KEY` entry in the effective env schema.
