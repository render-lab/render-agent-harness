## @render-harness/cap-browser-browserbase

Wires Browserbase headless-browser into a Render harness entry:

```yaml
capabilities:
  - pack: "@render-harness/cap-browser-browserbase"
```

Set `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` in the entry's environment.

The pack contributes:

- An MCP server `cap-browser-browserbase.browserbase` (stdio transport, runs `npx -y @browserbasehq/mcp`).
- A skill (`browserbase`).
- Two env-schema entries.

Browserbase is a hosted service; this pack adds no extra Render services.
