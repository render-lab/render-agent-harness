# Render Agent Harness

A Render-native agent harness. Built on Render primitives (Workflows, Workers, Cron, Postgres, Key Value, private services), provider-agnostic at the model layer, MCP-first for tools.

The harness is a thin core wrapped by three runtime adapters. The same agent definition runs unchanged across all three runtimes — pick the one that matches your shape:

| Runtime | Trigger | Use when |
|---|---|---|
| `runtime-cron` | Schedule | Run completes inside 12 hours, no user interaction. Audits, periodic jobs, monitoring. |
| `runtime-worker` *(Phase 3)* | Queue / event | Streaming output, low latency, always-on, webhook receivers. |
| `runtime-workflows` *(Phase 4)* | HTTP / API | Long-running, durable, human-in-the-loop, survives deploys. |

## Status

- Phase 0 — verifications: **done** (see [`docs/architecture.md`](docs/architecture.md))
- Phase 1 — core skeleton: **done**
- Phase 2 — Cron runtime + citations-monitor example: **done**
- Phase 3 — Worker runtime + Slack support agent: planned
- Phase 4 — Workflows runtime + deploy agent: planned
- Phase 5 — Hardened mode + docs: planned

## Repo layout

```
packages/
  core/                  # Shared loop, adapters, MCP, state, skills, prompt, tools
  runtime-cron/          # Cron one-shot runtime (this phase)
  runtime-worker/        # Queue-driven runtime (Phase 3)
  runtime-workflows/     # Render Workflows runtime (Phase 4)
  web/                   # Public web service (Phase 3+)

examples/
  citations-monitor/     # Cron: AEO citations tracker (this phase)
  support-agent/         # Worker: streaming Slack agent (Phase 3)
  deploy-agent/          # Workflows: deploys repos to Render (Phase 4)

blueprints/
  render.demo.yaml       # Single cron + Postgres (this phase)
  render.private.yaml    # Web + worker pserv + MCP pservs (Phase 3+)
  render.hardened.yaml   # Private + egress allowlist + audit (Phase 5)

docs/
  architecture.md        # The architecture and Phase 0 verifications
```

## Quickstart: deploy the citations-monitor in 15 minutes

The citations-monitor cron audits a tracked set of queries against an AI search engine each day and writes a Markdown summary into Postgres.

1. Fork this repo.
2. In the [Render Dashboard](https://dashboard.render.com), create a new Blueprint pointing at your fork. Pick `blueprints/render.demo.yaml`.
3. Render provisions a managed Postgres database and a daily cron job.
4. Set the two secret env vars on the cron service:
   - `ANTHROPIC_API_KEY` — the model the *agent* uses (Claude Sonnet 4.7 by default).
   - `SEARCH_ENGINE_API_KEY` — the model the *agent audits* (defaults to OpenAI `gpt-5`).
5. Trigger the cron manually from the Dashboard. The agent runs end-to-end and writes the audit summary to `agent_messages` and the structured audit rows to `aeo_audits`.

```sql
-- Inspect the most recent run's summary
SELECT m.created_at, m.content
  FROM agent_messages m
  JOIN agent_runs r ON r.id = m.run_id
 WHERE r.agent_name = 'citations-monitor'
   AND m.role = 'assistant'
 ORDER BY m.created_at DESC
 LIMIT 1;
```

See [`examples/citations-monitor/README.md`](examples/citations-monitor/README.md) for the full walkthrough.

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

Both services bind to `127.0.0.1` only. If your host already runs Postgres
or Redis on the default ports, override the host port:

```sh
HARNESS_PG_PORT=55432 HARNESS_KV_PORT=56379 pnpm db:up
```

### Run the citations-monitor end to end

```sh
# 1. Bring up the stack
pnpm db:up

# 2. Set your API keys (env vars or examples/citations-monitor/.env)
export ANTHROPIC_API_KEY=sk-ant-...
export SEARCH_ENGINE_API_KEY=sk-...
# Defaults assume the Compose stack:
#   DATABASE_URL=postgres://harness:harness@127.0.0.1:5432/harness
#   KV_URL=redis://127.0.0.1:6379

# 3. Run the agent. Migrations + seed queries run on first boot.
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
3. **Three runtimes on shared core**, built in order: Cron → Worker → Workflows.
4. **State in Postgres, signals in Key Value, streaming via LISTEN/NOTIFY.** No Redis dependency.
5. **Private services as the production default.** Demo mode collapses to one service.
6. **MCP for tools.** Both stdio and Streamable HTTP supported in v1.

## License

MIT.
