## @render-harness/cap-search-exa

Wires Exa web search into a Render harness entry. Drop into `render-harness.yaml`:

```yaml
capabilities:
  - pack: "@render-harness/cap-search-exa"
    config:
      defaultMaxResults: 10
```

Set `EXA_API_KEY` in the entry's environment.

The pack contributes:

- An MCP server `cap-search-exa.exa` (HTTP transport) talking to Exa's hosted MCP.
- A skill (`web-search-exa`) describing when to use Exa.
- An `EXA_API_KEY` entry in the effective env schema.
