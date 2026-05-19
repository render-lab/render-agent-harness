# Deploy agent

A Workflows-driven agent that takes a GitHub repo URL and produces a running Render web service — pausing for human approval before every destructive call (`create_*`, `update_*`, `delete_*`).

**Runtime:** workflows only. Durable, observable in the Render Workflows UI, HITL-friendly. The agent's per-run budget (`maxCostUsd: 5`, `maxIterations: 60`, `maxWallSeconds: 1800`) caps the blast radius if it goes off the rails.

**MCP servers:** Render MCP at `https://mcp.render.com/mcp`, bearer-auth via `RENDER_API_KEY`. No `cap-*` packs — all platform actions go through the MCP.

**Env vars:** `RENDER_API_KEY` (workspace-scoped, needs write access for the destructive endpoints to be callable post-approval).

**Use this as a starting point if:** you want a deploy assistant that won't surprise-create services or wipe a database. Every mutation is in the `permissions.requireApproval` list; the operator UI surfaces an approval card for each one with the full proposed spec. The agent's system prompt is explicit about cheapest-that-works plan choices and refuses to assume autoscaling, custom domains, or paid tiers.

Workflows requires a Workflow service in the Render Dashboard (see the deploy emitter's checklist). The scaffolder will print the steps after `pnpm install`.
