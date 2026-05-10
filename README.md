# Render Agent Harness

A Render-native agent harness. Built on Render primitives (Workflows, Workers, Cron, Postgres, Key Value, private services), provider-agnostic at the model layer, MCP-first for tools, with a [config registry](#config-registry) for one-click-deploy entries.

The harness is a thin core wrapped by four runtime adapters. The same agent definition runs unchanged across all of them — pick the one that matches your shape:

| Runtime | Trigger | Use when |
|---|---|---|
| `runtime-web` | HTTP request | Sub-30s synchronous agent, demos, hackathons, single-tenant prototypes. One service, one process, agent runs in-request. |
| `runtime-cron` | Schedule | Run completes inside 12 hours, no user interaction. Audits, periodic jobs, monitoring. |
| `runtime-worker` | Queue / event | Streaming output, low latency, always-on, webhook receivers, multi-tenant. Production shape. |
| `runtime-workflows` | Render Workflows task | Long-running, durable, human-in-the-loop, survives deploys. Each checkpoint is a subtask in the Workflows UI. |

For multi-tenant production deployments, the `@render-harness/web` package fronts `runtime-worker` with API-key-bearer auth, SSE streaming via Postgres `LISTEN/NOTIFY`, cooperative cancel, and a HITL `/runs/:id/input` endpoint.

## Status

- Phase 0 — verifications: **done** (see [`docs/architecture.md`](docs/architecture.md))
- Phase 1 — core skeleton: **done**
- Phase 2 — Cron runtime + citations-monitor example: **done**
- Phase 2.5 — Web runtime + web-chat example: **done**
- Phase 3 — Worker runtime + multi-tenant web service + support-agent: **done**
- Phase 4 — Workflows runtime + deploy-agent: **done**
- Phase 5 — Hardened mode + docs: planned

## Repo layout

```
packages/
  core/                  # Shared loop, adapters, MCP, state, skills, prompt, tools
  runtime-cron/          # Cron one-shot runtime
  runtime-web/           # Synchronous HTTP request handler runtime
  runtime-worker/        # pg-boss queue consumer with soft checkpoint
  runtime-workflows/     # Render Workflows: per-step task with HITL approval
  web/                   # Multi-tenant public web service in front of runtime-worker

  registry/              # Config registry: schema, defineFromConfig(), emitter, render-harness-build bin
  capabilities/          # First-party capability packs (search/scrape/memory/browser)

examples/
  citations-monitor/     # Cron: AEO citations tracker
  web-chat/              # Web: chat agent with optional Render MCP
  support-agent/         # Worker: Slack-driven agent with Slack MCP
  deploy-agent/          # Workflows: deploys repos to Render via Render MCP

blueprints/
  render.demo.yaml       # Single web service + Postgres (web-chat)
  render.demo-cron.yaml  # Single cron + Postgres (citations-monitor)
  render.private.yaml    # Production: web + worker pserv + Postgres + KV (support-agent)
  render.hardened.yaml   # Private + egress allowlist + audit (Phase 5)

templates/
  render-harness-entry/  # Starter template for new registry entries

registry-index/
  index.json             # Decentralized registry index (entries by repo + SHA)
  scripts/               # Validation scripts (schema + entry-fetch CI)
  site/                  # Static discovery site

docs/
  architecture.md        # The architecture and Phase 0 verifications
```

## Quickstart: deploy a chat agent in 5 minutes

The `web-chat` example is the smallest possible deployment: one Render web service, one process, agent runs in the HTTP request handler.

1. Fork this repo.
2. In the [Render Dashboard](https://dashboard.render.com), create a new Blueprint pointing at your fork. Pick `blueprints/render.demo.yaml`.
3. Render provisions a managed Postgres and the web service.
4. Set the secret env var on the web service:
   - `ANTHROPIC_API_KEY` — required, the model the agent uses.
   - `RENDER_API_KEY` — optional, enables Render MCP tools (read-only by default).
5. `curl` the assigned `https://*.onrender.com` URL:

```sh
curl -sS https://your-app.onrender.com/runs \
  -H 'content-type: application/json' \
  -d '{"input":"List my Render services"}' | jq

# Streaming
curl -N https://your-app.onrender.com/runs/stream \
  -H 'content-type: application/json' \
  -d '{"input":"What's my newest deploy?"}'
```

See [`examples/web-chat/README.md`](examples/web-chat/README.md) for the full walkthrough.

### Alt quickstart: scheduled audits with the citations-monitor cron

For an unattended cron variant of demo mode (audits queries against an AI search engine, summarizes results to Postgres), use `blueprints/render.demo-cron.yaml`. See [`examples/citations-monitor/README.md`](examples/citations-monitor/README.md).

### Headline: Workflows-driven deploy agent

`examples/deploy-agent` takes a GitHub repo URL and deploys it to Render via Render MCP. The whole loop is visible in the Render Workflows UI: each agent checkpoint is a chained subtask, and every destructive Render API call (create/update/delete service, postgres, key value, env vars) pauses for human approval.

```sh
pnpm db:up
cp examples/deploy-agent/.env.example examples/deploy-agent/.env
# fill in ANTHROPIC_API_KEY and RENDER_API_KEY

pnpm --filter @render-harness/example-deploy-agent build
pnpm --filter @render-harness/example-deploy-agent dev:workflow

# in another shell:
pnpm --filter @render-harness/example-deploy-agent trigger \
  --repo https://github.com/render-examples/express-hello-world \
  --name hello-from-deploy-agent --await

# when the run pauses for approval:
pnpm --filter @render-harness/example-deploy-agent trigger \
  --resume <runId> --approve <toolUseId> --await
```

Render Workflows aren't yet supported in `render.yaml`, so the workflow service must be created in the Dashboard. See [`examples/deploy-agent/README.md`](examples/deploy-agent/README.md) for the deploy checklist.

### Production: Slack support agent on the private network

`blueprints/render.private.yaml` provisions the production-shape stack: a public web service that receives Slack Events, a private worker pserv that runs the agent with Slack MCP, plus managed Postgres and Render Key Value on the private network.

```sh
# Local dev requires two processes plus the Compose stack.
pnpm db:up
cp examples/support-agent/.env.example examples/support-agent/.env
# fill in ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
pnpm --filter @render-harness/example-support-agent dev:worker  # terminal 1
pnpm --filter @render-harness/example-support-agent dev:web     # terminal 2
ngrok http 8080  # expose web for Slack Events delivery
```

See [`examples/support-agent/README.md`](examples/support-agent/README.md) for the full deploy walkthrough including Slack app setup.

## Config registry

Each runtime can be packaged as a registry entry: a small repo with a declarative `render-harness.yaml`, a committed `render.yaml`, and (optionally) custom TypeScript agent code. End users deploy with one click via a Deploy-to-Render badge — no CLI, no API key. Authors regenerate `render.yaml` from `render-harness.yaml` with `npx render-harness-build`.

**[Read the registry guide](docs/registry-guide.md)** for end-to-end walkthroughs (deploying, authoring, contributing packs).

Where things live:

- [`packages/registry/`](packages/registry) — schema, `defineFromConfig()` runtime library, Blueprint emitter, `render-harness-build` bin.
- [`packages/capabilities/`](packages/capabilities) — first-party capability packs: search (Exa, Tavily), scraping (Firecrawl), long-term memory (Postgres), browser automation (Browserbase). Community packs live on npm with the `render-harness-cap` keyword.
- [`templates/render-harness-entry/`](templates/render-harness-entry) — starter template for a new entry.
- [`registry-index/`](registry-index) — the decentralized index file, validation CI, and discovery static site.

See [`docs/architecture.md`](docs/architecture.md#config-registry) for the full contract, namespacing rules, and the Blueprint shape table.

## Local development

Requires Node 22+, pnpm 10+, and Docker (for the local Postgres + Valkey
stack).

### One-time setup

```sh
corepack enable
pnpm install
pnpm build
pnpm test
```

### Bring up the local primitives

The repo ships a `compose.yaml` that runs the same primitives Render gives
you in production: Postgres 17 (matches the `render.demo.yaml` Blueprint)
and Valkey 8 (Redis-compatible, matches Render Key Value).

```sh
pnpm db:up        # start postgres + valkey, wait for healthchecks
pnpm db:logs      # tail compose logs
pnpm db:psql      # open psql in the postgres container
pnpm db:valkey    # open valkey-cli in the valkey container
pnpm db:reset     # nuke volumes and restart with a fresh DB
pnpm db:down      # stop everything
```

Both services bind to `127.0.0.1` only and use non-standard host ports
(`55432` for Postgres, `56379` for Valkey) so they don't collide with a
host-installed Postgres or Redis. If even those ports are taken, override:

```sh
HARNESS_PG_PORT=15432 HARNESS_KV_PORT=16379 pnpm db:up
```

Inside containers the services still listen on the canonical 5432/6379, so
nothing else needs to change.

### Run the web-chat agent end to end

```sh
pnpm db:up
cp examples/web-chat/.env.example examples/web-chat/.env
# fill in ANTHROPIC_API_KEY (and optionally RENDER_API_KEY)
pnpm dev:web

# in another shell:
curl -sS http://localhost:8080/runs \
  -H 'content-type: application/json' \
  -d '{"input":"What can you help me with?"}' | jq
```

### Run the citations-monitor cron end to end

```sh
pnpm db:up
cp examples/citations-monitor/.env.example examples/citations-monitor/.env
# fill in ANTHROPIC_API_KEY and SEARCH_ENGINE_API_KEY
pnpm dev:citations
```

When the run finishes, inspect what happened:

```sh
pnpm db:psql

# inside psql:
SELECT id, status, total_cost_usd, finished_at FROM agent_runs ORDER BY created_at DESC LIMIT 5;
SELECT role, jsonb_array_length(content) AS blocks FROM agent_messages ORDER BY seq;
SELECT query_id, was_cited, response_excerpt FROM aeo_audits ORDER BY created_at DESC;
```

### Cancel a running agent (worker / future runtimes)

Cancellation is KV-backed. To cancel a run from another shell:

```sh
pnpm db:valkey
> SET cancel:<run-id> user_requested EX 3600
```

The cron runtime polls this flag every 500 ms between turns and tool calls.

## Locked decisions

These are documented in [`docs/architecture.md`](docs/architecture.md). They're not up for relitigation in PRs:

1. **TypeScript** end-to-end.
2. **No agent framework dependency.** Direct Anthropic SDK + OpenAI SDK behind a thin `LLMClient` interface.
3. **Four runtimes on shared core** (Web, Cron, Worker, Workflows). Cron came first; Web shipped in Phase 2.5.
4. **State in Postgres, signals in Key Value, streaming via LISTEN/NOTIFY.** No Redis dependency.
5. **Private services as the production default.** Demo mode collapses to one service.
6. **MCP for tools.** Both stdio and Streamable HTTP supported in v1.

## License

MIT.
