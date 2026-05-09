# web-chat

A minimal Render web service that serves a chat agent. POST a message, get an answer. Optional Render MCP integration lets the agent introspect your Render workspace.

This is the "smallest possible deployment" example for the harness. One process, one service, agent runs entirely in the HTTP request handler.

## How it works

```
client ─POST /runs─▶ web-chat ─runAgent()─▶ Anthropic
                         │
                         └─(optional)─▶ Render MCP ─▶ Render API
```

- `POST /runs` runs the agent to completion in the request and returns the final assistant message as JSON.
- `POST /runs/stream` runs the same flow but streams every message, tool call, and tool result as Server-Sent Events.
- `GET /healthz` for liveness probes.

State (runs, messages, tool calls, results) lands in the same Postgres tables the rest of the harness uses (`agent_runs`, `agent_messages`, `agent_tool_calls`, `agent_tool_results`). Each request creates a new run; conversation history doesn't carry across requests in this example.

## Try it locally

```sh
# in repo root
pnpm db:up
cp examples/web-chat/.env.example examples/web-chat/.env
# fill in ANTHROPIC_API_KEY (and optionally RENDER_API_KEY)
pnpm --filter @render-harness/example-web-chat dev
```

In another shell:

```sh
# Sync request — wait for the final answer
curl -sS http://localhost:8080/runs \
  -H 'content-type: application/json' \
  -d '{"input":"What can you help me with?"}' | jq

# Streaming request — watch the agent think
curl -N http://localhost:8080/runs/stream \
  -H 'content-type: application/json' \
  -d '{"input":"List my Render services"}'
```

## With Render MCP

Set `RENDER_API_KEY` to a workspace API key from <https://dashboard.render.com/u/settings#api-keys>. The agent gets read-only access to Render's MCP tools (list services, read deploys, inspect databases, etc.). Destructive tools are explicitly denied in `src/main.ts` — remove the `deniedTools` list to opt back in.

## Deploy on Render

1. Fork the repo.
2. In the Render Dashboard, create a Blueprint from `blueprints/render.demo.yaml`.
3. Set `ANTHROPIC_API_KEY` (and optionally `RENDER_API_KEY`) on the web service.
4. Visit the public `onrender.com` URL Render assigns and `curl` the `/runs` endpoint.

## Limits

- This runtime runs to completion inside a single HTTP request. Render's web service request timeout is generous but tool loops longer than a few minutes will exceed practical client patience. Use the cron or worker runtime for longer agents.
- No conversation memory across requests. To chat across requests, persist a session id in the request body and use it to look up prior messages — left as an exercise; see the agent_messages table.
- Single-tenant by default. For multi-tenant production deployments, the Phase 3 `packages/web` service plus `runtime-worker` is the right shape.
