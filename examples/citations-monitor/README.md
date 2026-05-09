# citations-monitor

A Render cron job that audits an AI search engine for brand citations on a tracked set of queries. Runs daily, writes results to Postgres, and produces a single Markdown summary you can read in `agent_messages`.

This is the canonical "Phase 2" example for the harness. It demonstrates:

- **Cron runtime** — one-shot, run-to-completion, exits on success.
- **Local tools** — Postgres I/O and a search-engine call wrapped as MCP-shaped tools.
- **Skills** — `auditing-protocol` and `summary-format` loaded on demand by the agent.
- **Provider-agnostic model layer** — Anthropic for the agent, any OpenAI-compatible endpoint for the audited engine.

## How it works

1. The cron boots, applies migrations, creates a new `agent_runs` row, and calls `runAgent`.
2. The agent reads its skills index from the system prompt, calls `load_skill` for both skills, and calls `list_tracked_queries`.
3. For each query, the agent calls `query_search_engine`, decides if the brand was cited per the auditing protocol, and calls `record_audit`.
4. The agent calls `summarize_recent_audits`, then composes a final Markdown summary and returns it as its final message.
5. The cron exits with status 0; Render marks the run as healthy.

The agent's behavior lives entirely in `src/agent.ts` (the system prompt + skills + tool definitions). Swap the prompt and skills and you have a different agent. The cron entrypoint in `src/main.ts` is 25 lines.

## Schema

The example adds two tables alongside the harness's own (`agent_runs`, `agent_messages`, etc.):

- `aeo_queries` — the queries you want monitored. Seeded with 5 starter queries on first run; edit them in Postgres or via your own admin UI.
- `aeo_audits` — one row per (query, run) pair, with the raw response and a `was_cited` boolean.

```sql
-- Trend report: cite rate per week
SELECT
  date_trunc('week', a.created_at) AS week,
  count(*) AS audits,
  round(100.0 * sum(case when a.was_cited then 1 else 0 end) / count(*), 1) AS cite_rate_pct
FROM aeo_audits a
GROUP BY 1
ORDER BY 1 DESC;
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (required) | Render-managed Postgres connection string. |
| `ANTHROPIC_API_KEY` | (required) | The model the *agent* uses for reasoning. |
| `LLM_MODEL` | `claude-sonnet-4-7` | The agent's model. Override to use a different Claude model. |
| `SEARCH_ENGINE_API_KEY` | (required) | API key for the engine being audited. |
| `SEARCH_ENGINE_BASE_URL` | OpenAI default | Set to point at OpenRouter, Perplexity, etc. |
| `SEARCH_ENGINE_MODEL` | `gpt-5` | Model identifier on the audited engine. |
| `KV_URL` / `REDIS_URL` | unset | Optional. If set, the cron runtime polls the cancel flag from Render Key Value. |
| `LOG_LEVEL` | `info` | `debug` shows tool dispatch and prompt assembly. |

## Local development

```sh
# in repo root
corepack enable
pnpm install

# point at a local Postgres
export DATABASE_URL='postgres://localhost:5432/harness'
export ANTHROPIC_API_KEY=sk-ant-...
export SEARCH_ENGINE_API_KEY=sk-...

pnpm dev:citations
```

Or copy `.env.example` → `.env` inside `examples/citations-monitor/` and the `dotenv` loader will pick it up.

## Customising the queries

Edit the seed in `sql/0001_init.sql` for the initial set, or `INSERT` more rows directly:

```sql
INSERT INTO aeo_queries (id, query_text, target_brand, notes)
VALUES ('q-my-query', 'How do I deploy a FastAPI app?', 'Render', 'Framework intent');
```

Toggle a query off without deleting it:

```sql
UPDATE aeo_queries SET enabled = false WHERE id = 'q-vercel-alt';
```

## Deploy on Render

1. Fork the repo.
2. In the Render Dashboard, create a Blueprint from `blueprints/render.demo.yaml`.
3. Set `ANTHROPIC_API_KEY` and `SEARCH_ENGINE_API_KEY` on the cron service.
4. Trigger the cron manually from the Dashboard to verify the first run.
5. Schedule fires daily at 13:00 UTC by default. Edit `schedule:` in the Blueprint to change.
