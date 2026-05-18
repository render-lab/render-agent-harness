# Render Agent Harness

> [!WARNING]
> **Experimental.** This project is in active development. Public APIs, the `render-harness.yaml` schema, capability pack contracts, and CLI behavior may change without notice between 0.x releases. Expect rough edges, breaking releases, and gaps in documentation. Pin exact versions, read changelogs before upgrading, and please open an issue when something breaks.

A Render-native agent harness. Built on Render primitives (Workflows, Workers, Cron, Postgres, Key Value, private services), provider-agnostic at the model layer, MCP-first for tools, with a [config registry](#config-registry) for one-click-deploy entries.

The harness is a thin core wrapped by four runtime adapters. The same agent definition runs unchanged across all of them — pick the one that matches your shape:

| Runtime | Trigger | Use when |
|---|---|---|
| `runtime-web` | HTTP request | Sub-30s synchronous agent, demos, hackathons, single-tenant prototypes. One service, one process, agent runs in-request. |
| `runtime-cron` | Schedule | Run completes inside 12 hours, no user interaction. Audits, periodic jobs, monitoring. |
| `runtime-worker` | Queue / event | Streaming output, low latency, always-on, webhook receivers, multi-tenant. Production shape. |
| `runtime-workflows` | Render Workflows task | Long-running, durable, human-in-the-loop, survives deploys. Each checkpoint is a subtask in the Workflows UI. |

For multi-tenant production deployments, the `@render-harness/web` package fronts `runtime-worker` with API-key-bearer auth, SSE streaming via Postgres `LISTEN/NOTIFY`, cooperative cancel, a HITL `/runs/:id/input` endpoint, and a first-class conversations API (`POST /conversations`, `POST /conversations/:id/messages`, `GET /conversations/:id/stream`) for multi-turn chat that groups many runs under one conversation. Operators can opt into `@render-harness/ui` (`serveWeb({ ui: true })`) for a browser control plane: chat with the agent across multi-turn sessions, list/inspect runs, watch live, cancel, inject HITL input, see loaded agents, and view usage rollups. See [`docs/ui-guide.md`](docs/ui-guide.md).

## How the pieces fit together

Render Agent Harness has three structural layers:

- **Harness:** The shared runtime substrate. It owns the agent loop, model adapters, state, streaming, cancellation, MCP wiring, built-in tools, and Render deployment shapes.
- **Agents:** The product logic that runs on the harness. An agent is a `defineAgent()` TypeScript definition, or a `render-harness.yaml` entry that resolves to one. It declares the model, prompt, permissions, MCP servers, skills, local tools, and runtime triggers.
- **Capabilities:** Reusable extension packs that add tools, env vars, setup requirements, and prompt guidance to one or more agents. Capabilities are npm packages under `packages/capabilities/` or community packages with the `render-harness-cap` keyword.

The relationship is deliberately narrow: runtimes start work, the harness executes it, agents describe what work to do, and capabilities provide reusable powers the agent can opt into. The same agent can run as a web request, worker job, cron invocation, or Workflow task without changing its business logic.

```
render-harness.yaml or defineAgent()
          │
          ▼
AgentDefinition ── loads ── capabilities + MCP servers + built-in tools
          │
          ▼
@render-harness/core runAgent()
          │
          ▼
runtime-web | runtime-worker | runtime-cron | runtime-workflows
          │
          ▼
Render primitives: Postgres, Key Value, private services, Cron, Workflows
```

## Quickstart: scaffold a new agent

The fastest path to a working agent is the wizard CLI:

```sh
npx create-render-agent my-agent
# or: npm init render-agent my-agent / pnpm dlx create-render-agent my-agent
```

It asks for the trigger surfaces (web / cron / worker, multi-select), system prompt, model, capability packs, and optional operator UI. The output is a ready-to-run project with `render-harness.yaml`, a `docker-compose.yml` for Postgres + Valkey, a Deploy-to-Render button in the README, and all the runtime entrypoints wired up.

```sh
cd my-agent
pnpm install
cp .env.example .env       # fill in ANTHROPIC_API_KEY
pnpm db:up                 # local Postgres + Valkey via docker-compose
pnpm dev
```

There's also a **browser wizard** (`@render-harness/wizard`, Phase 3) that runs the same flow no-code: pick template → fill prompt → click Deploy. It creates a managed GitHub repo and returns a one-click Deploy-to-Render link. See [`docs/ui-scaffolder-plan.md`](docs/ui-scaffolder-plan.md).

**Note:** until the harness publishes to npm (see [`docs/publish-plan.md`](docs/publish-plan.md)), use `npx create-render-agent --harness-root /path/to/render-harness my-agent` to wire `link:` deps to a local checkout. Once published, the flag becomes a contributor-only convenience.

## Status

Core platform:

- Phase 0 — verifications: **done** (see [`docs/architecture.md`](docs/architecture.md))
- Phase 1 — core skeleton: **done**
- Phase 2 — Cron runtime + citations-monitor example: **done**
- Phase 2.5 — Web runtime + web-chat example: **done**
- Phase 3 — Worker runtime + multi-tenant web service + support-agent: **done**
- Phase 4 — Workflows runtime + deploy-agent: **done**
- Phase 5 — Hardened mode + docs: planned

Onboarding & distribution (see [`docs/onboarding-plan.md`](docs/onboarding-plan.md)):

- Phase 1 — CLI scaffolder (`npx create-render-agent`): **done** ([`docs/cli-scaffolder-plan.md`](docs/cli-scaffolder-plan.md))
- Phase 2 — In-monorepo gallery + capability discovery: **done** ([`docs/gallery-plan.md`](docs/gallery-plan.md))
- Phase 3 v1 — Browser wizard + managed-repo (anonymous): **done** ([`docs/ui-scaffolder-plan.md`](docs/ui-scaffolder-plan.md))
- Phase 3 v2 — "My agents" dashboard, auth, graduation flow: planned
- Publish to npm — changesets + GHA release workflow: planned ([`docs/publish-plan.md`](docs/publish-plan.md))

## Built-in tools

Every agent ships with a default toolset out of the box — no MCP wiring required, no `localTools` to write. The toolset is assembled by `buildBuiltinTools()` in [`packages/core/src/builtins/`](packages/core/src/builtins/) and concatenated with the agent's own tools before they reach the model. Each tool decides at boot whether its preconditions are met; tools whose env or harness preconditions aren't satisfied skip cleanly with a logged reason (operator UI surfaces this via `GET /agents`).

| Tool | Tier | Notes |
|---|---|---|
| `load_skill`, `fetch_full_result` | A | Infrastructural — load skill bodies on demand, fetch the full payload of a previously-truncated tool result. |
| `fetch_url` | A | HTTP GET with SSRF guard (blocks loopback / private / link-local / cloud-metadata IPs), 1 MB cap, 15s timeout, 3-redirect cap. |
| `current_time` | A | UTC + optional IANA timezone conversion. |
| `ask_user` | A | Pause the run and request input. Resumes via `POST /runs/:id/input`. |
| `todo` | A | Per-run scratchpad task list, persisted in `agent_runs.metadata`. |
| `list_my_runs` | C | Read-only view of the caller's recent runs (Postgres). Hard-scoped by `userId`. |
| `web_search` | B | Provider chain: `EXA_API_KEY` → `TAVILY_API_KEY` → `BRAVE_API_KEY`. |
| `web_extract` | B | Provider chain: `FIRECRAWL_API_KEY` → `EXA_API_KEY`. |
| `image_generate` | B | Provider chain: `OPENAI_API_KEY` → `FAL_KEY`. |

Override Tier B provider selection with `HARNESS_WEB_SEARCH_PROVIDER`, `HARNESS_WEB_EXTRACT_PROVIDER`, `HARNESS_IMAGE_PROVIDER`. Per-agent opt-out uses the existing `permissions.deniedTools` / `permissions.allowedTools`.

For path-scoped filesystem access, install [`@render-harness/cap-filesystem`](packages/capabilities/cap-filesystem/) per agent — filesystem and terminal tools are deliberately not core defaults because the production worker pserv is multi-tenant.

## Repo layout

```
packages/
  core/                  # Shared loop, adapters, MCP, state, skills, prompt, tools
  contracts/             # Wire types shared between server (web) and SPA (ui/wizard)
  runtime-cron/          # Cron one-shot runtime
  runtime-web/           # Synchronous HTTP request handler runtime
  runtime-worker/        # pg-boss queue consumer with soft checkpoint
  runtime-workflows/     # Render Workflows: per-step task with HITL approval
  web/                   # Multi-tenant public web service in front of runtime-worker
  ui/                    # Optional operator control-plane UI (mounts on `web`)
  registry/              # Config registry: schema, defineFromConfig(), emitter,
                         # gallery loader, render-harness-build bin
  capabilities/          # First-party capability packs (search / scrape / memory /
                         # browser / filesystem)
  create-render-agent/   # CLI scaffolder — `npx create-render-agent`
  wizard/                # Browser scaffolder (Hono + React SPA) — Phase 3 v1

gallery/
  index.yaml             # Curated agent templates surfaced by the CLI + wizard
  agents/<slug>/         # Per-template render-harness.yaml + README

examples/
  citations-monitor/     # Cron: AEO citations tracker
  web-chat/              # Web: chat agent with optional Render MCP
  support-agent/         # Worker: Slack-driven agent with Slack MCP
  operator-demo/         # Web + worker + operator UI mounted at /ui
  deploy-agent/          # Workflows: deploys repos to Render via Render MCP

blueprints/
  render.demo.yaml       # Single web service + Postgres (web-chat)
  render.demo-cron.yaml  # Single cron + Postgres (citations-monitor)
  render.private.yaml    # Production: web + worker pserv + Postgres + KV (support-agent)
  render.hardened.yaml   # Private + egress allowlist + audit (Phase 5)

templates/
  render-harness-entry/  # Starter template (manual `cp -r` alternative to the CLI)

registry-index/
  index.json             # Decentralized registry index (entries by repo + SHA)
  scripts/               # Validation scripts (schema + entry-fetch CI)
  site/                  # Static discovery site

docs/
  architecture.md        # Architecture + Phase 0 verifications
  onboarding-plan.md     # Direction doc: CLI + gallery + UI scaffolder
  cli-scaffolder-plan.md # Phase 1 plan (shipped)
  gallery-plan.md        # Phase 2 plan (shipped)
  ui-scaffolder-plan.md  # Phase 3 plan (v1 shipped)
  publish-plan.md        # Changesets + GHA + first npm publish (planned)
  registry-guide.md      # End-user + author + contributor guide for the registry
  ui-guide.md            # Operator-UI feature documentation
  connectors-plan.md     # Inbound connectors (Slack, webhook generic)
  conversations-plan.md  # Threaded runs / first-class conversations
  recurring-tasks-plan.md
```

## Deploy paths

Three first-class ways to ship an agent on Render, in order of friction:

### 1. Browser wizard (Phase 3 v1)

`packages/wizard` — a Hono service serving a React SPA at `/`. Pick a template, fill the prompt, click Create. Backend creates a managed GitHub repo and returns a Deploy-to-Render URL. Anonymous; no login needed.

Local dev:

```sh
cd packages/wizard
pnpm build
MOCK_SCAFFOLD=1 pnpm start
# open http://127.0.0.1:8090
```

See [`docs/ui-scaffolder-plan.md`](docs/ui-scaffolder-plan.md).

### 2. CLI scaffolder (Phase 1)

`npx create-render-agent my-agent` — same questions, terminal UX. Output is a self-contained project repo with docker-compose, env templates, the right runtime entrypoints, and `render-harness.yaml`. See the [Quickstart](#quickstart-scaffold-a-new-agent) above and [`docs/cli-scaffolder-plan.md`](docs/cli-scaffolder-plan.md).

### 3. Fork + Blueprint (original path)

Fork this repo, point Render at one of the [`blueprints/*.yaml`](blueprints/) files, set the secret env vars, deploy. Best for hacking on the harness itself rather than running an agent built on top of it.

```sh
# In the Render Dashboard:
#   1. New Blueprint → point at your fork → pick blueprints/render.demo.yaml
#   2. Set ANTHROPIC_API_KEY (required), RENDER_API_KEY (optional)
#   3. Wait ~2 min for provisioning
```

Then:

```sh
curl -sS https://your-app.onrender.com/runs \
  -H 'content-type: application/json' \
  -d '{"input":"List my Render services"}' | jq
```

See [`examples/web-chat/README.md`](examples/web-chat/README.md) for the full walkthrough.

### Workflows-driven deploy agent

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

- [`packages/registry/`](packages/registry) — schema, `defineFromConfig()` runtime library, Blueprint emitter, `render-harness-build` bin, gallery loader.
- [`packages/capabilities/`](packages/capabilities) — first-party capability packs: search (Exa, Tavily), scraping (Firecrawl), long-term memory (Postgres), browser automation (Browserbase), filesystem. Community packs live on npm with the `render-harness-cap` keyword.
- [`gallery/`](gallery) — curated starter templates surfaced by both the CLI and the browser wizard.
- [`templates/render-harness-entry/`](templates/render-harness-entry) — manual starter template (the CLI is the recommended path).
- [`registry-index/`](registry-index) — the decentralized index file, validation CI, and discovery static site.

See [`docs/architecture.md`](docs/architecture.md#config-registry) for the full contract, namespacing rules, and the Blueprint shape table.

## Local development

Requires Node 22+, pnpm 10+, and Docker (for the local Postgres + Valkey stack).

### One-time setup

```sh
corepack enable
pnpm install
pnpm build
pnpm test
```

### Bring up the local primitives

The repo ships a `compose.yaml` that runs the same primitives Render gives you in production: Postgres 17 (matches the `render.demo.yaml` Blueprint) and Valkey 8 (Redis-compatible, matches Render Key Value).

```sh
pnpm db:up        # start postgres + valkey, wait for healthchecks
pnpm db:logs      # tail compose logs
pnpm db:psql      # open psql in the postgres container
pnpm db:valkey    # open valkey-cli in the valkey container
pnpm db:reset     # nuke volumes and restart with a fresh DB
pnpm db:down      # stop everything
```

Both services bind to `127.0.0.1` only and use non-standard host ports (`55432` for Postgres, `56379` for Valkey) so they don't collide with a host-installed Postgres or Redis. If even those ports are taken, override:

```sh
HARNESS_PG_PORT=15432 HARNESS_KV_PORT=16379 pnpm db:up
```

Inside containers the services still listen on the canonical 5432/6379, so nothing else needs to change.

### Run the web-chat example end to end

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

### Run the operator-demo (web + worker + UI)

```sh
pnpm db:up
cp examples/operator-demo/.env.example examples/operator-demo/.env  # fill ANTHROPIC_API_KEY
pnpm dev:operator-web      # terminal 1
pnpm dev:operator-worker   # terminal 2
# open http://127.0.0.1:8082/ui/login — sign in with WEB_API_KEY
```

### Run the browser wizard locally

```sh
cd packages/wizard
pnpm build
MOCK_SCAFFOLD=1 pnpm start
# open http://127.0.0.1:8090 to click through the no-code scaffolder
```

### Cancel a running agent

Cancellation is KV-backed. To cancel a run from another shell:

```sh
pnpm db:valkey
> SET cancel:<run-id> user_requested EX 3600
```

The cron runtime polls this flag every 500 ms between turns and tool calls; the worker checks at the same boundaries.

## Locked decisions

These are documented in [`docs/architecture.md`](docs/architecture.md). They're not up for relitigation in PRs:

1. **TypeScript** end-to-end.
2. **No agent framework dependency.** Direct Anthropic SDK + OpenAI SDK behind a thin `LLMClient` interface.
3. **Four runtimes on shared core** (Web, Cron, Worker, Workflows). Cron came first; Web shipped in Phase 2.5.
4. **State in Postgres, signals in Key Value, streaming via LISTEN/NOTIFY.** No Redis dependency.
5. **Private services as the production default.** Demo mode collapses to one service.
6. **MCP for tools.** Both stdio and Streamable HTTP supported in v1.
7. **`@render-harness` is the npm scope, independent of the `render-lab` GitHub org.** See [`docs/publish-plan.md`](docs/publish-plan.md).

## License

MIT.
