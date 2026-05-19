# Cost watcher

A daily cron that hits the Render MCP server, estimates 24-hour projected spend per service, and pings Slack when something's running hotter than your threshold.

**Runtimes:** cron (daily at 15:00 UTC) + web (for on-demand runs).

**Capabilities pre-selected:** `@render-harness/cap-slack` (read_write, `slack_send_message` HITL-gated first time). Render workspace data comes from the Render MCP server (`https://mcp.render.com/mcp`, bearer-auth with `RENDER_API_KEY`) — no cap pack needed.

**Env vars:** `RENDER_API_KEY` (read-only is fine), `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `COST_CHANNEL`, optional `COST_THRESHOLD_USD` (default 50).

**Use this as a starting point if:** you've got a Render workspace with more than a few services and want a sanity check that nothing's silently autoscaled into the stratosphere overnight. The system prompt errs toward "rightsize / scale-adjust" recommendations rather than "delete this service".

The agent uses a tight budget (`maxIterations: 30`, `maxCostUsd: 1`, `maxWallSeconds: 300`) so the cron itself never becomes a cost concern.
