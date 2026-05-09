# deploy-agent

A Render Workflows agent that takes a GitHub repo URL and deploys it to Render via Render MCP. Headline Phase 4 demo.

This is the conference-talk example: the entire deploy loop is visible in the Workflows UI as a chain of subtasks; every destructive Render API call pauses for human approval; the agent reads a `deploy` skill and a `debug-build` skill on demand and uses them to recover from build failures.

## Architecture

```
   trigger CLI ─render.workflows.startTask─▶ Render Workflows
        │                                          │
        │ (resumes via --resume + --approve)      │ runs agent-step task
        ▼                                          ▼
   Postgres (harness state)                   runAgentStep()
        ▲                                          │
        │                                          │ runAgent() with soft checkpoint
        │                                          ▼
        └──────────────message/cursor────  @render-harness/core ──▶ Anthropic
                                                   │
                                                   └─MCP HTTP─▶ Render MCP ─▶ Render API
```

- **`src/main.ts`** — registers the single `agent-step` task. Each task invocation runs the agent until a checkpoint, pause, or terminal status. On checkpoint the task self-recurses (chained subtask, becomes another row in the Workflows UI).
- **`src/agent.ts`** — the `AgentDefinition`. Render MCP connection, system prompt, two skills, every destructive Render tool in `permissions.requireApproval`.
- **`src/trigger.ts`** — CLI to start a run or resume one with approvals.
- **`skills/deploy/SKILL.md`** — sequence the agent follows for a fresh deploy.
- **`skills/debug-build/SKILL.md`** — diagnostic recipes the agent loads on a build failure.

## Try it

### 1. Set up env

```sh
pnpm db:up
cp examples/deploy-agent/.env.example examples/deploy-agent/.env
# fill in ANTHROPIC_API_KEY and RENDER_API_KEY
```

### 2. Run the workflow service locally

The Render CLI ships a workflows dev server that simulates the Workflow runtime so tasks register and you can `runTask` them locally.

```sh
pnpm --filter @render-harness/example-deploy-agent build
pnpm --filter @render-harness/example-deploy-agent dev:workflow
```

The CLI prints a local task server endpoint. Leave it running.

### 3. Trigger a run

In another shell:

```sh
pnpm --filter @render-harness/example-deploy-agent trigger \
  --repo https://github.com/render-examples/express-hello-world \
  --name hello-from-deploy-agent \
  --await
```

You'll see the run id and a Workflows UI link. The first time the agent proposes a destructive call (`render__create_web_service`), the run pauses with a payload like:

```json
{ "status": "paused", "reason": "awaiting_approval",
  "payload": { "tool_use_id": "tu_abc123", "name": "render__create_web_service", "input": { ... } } }
```

Review the proposed `input` in the Workflows UI. To approve and resume:

```sh
pnpm --filter @render-harness/example-deploy-agent trigger \
  --resume <runId> --approve tu_abc123 --await
```

The agent continues, watches the deploy, and returns a final Markdown summary.

### 4. Inspect what happened

All run state lives in Postgres exactly like the other runtimes:

```sh
pnpm db:psql

-- The final summary message
SELECT m.created_at, substring(m.content::text, 1, 600) AS preview
  FROM agent_messages m JOIN agent_runs r ON r.id = m.run_id
 WHERE r.agent_name = 'deploy-agent' AND m.role = 'assistant'
 ORDER BY m.created_at DESC LIMIT 1;

-- Tool calls and their idempotency keys
SELECT name, status, idempotency_key, started_at, finished_at
  FROM agent_tool_calls WHERE run_id = '<runId>' ORDER BY created_at;
```

## Deploy on Render

**Render Workflows are not yet supported in `render.yaml` Blueprints.** Create the Workflow service manually in the Dashboard.

Checklist:

1. Push your fork to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click **New > Workflow**.
3. Connect the repo. Set:
   - **Language:** Node
   - **Root Directory:** `examples/deploy-agent`
   - **Build Command:** `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @render-harness/example-deploy-agent build`
   - **Start Command:** `node dist/main.js`
4. Add env vars:
   - `DATABASE_URL` — link the harness Postgres database (use the same one that powers your other harness services if you want shared state).
   - `KV_URL` — link Render Key Value if you want cancel signals.
   - `ANTHROPIC_API_KEY` — required.
   - `RENDER_API_KEY` — required.
   - `LLM_MODEL` — optional (defaults to `claude-sonnet-4-6`).
5. **Deploy Workflow.**
6. Note the **workflow slug** shown on the service page; it might differ from `deploy-agent` if Render disambiguated. Pass it to the trigger CLI with `--workflow <slug>`.

To trigger from your laptop after deploy:

```sh
RENDER_API_KEY=rnd_... \
  pnpm --filter @render-harness/example-deploy-agent trigger \
    --workflow <slug> --repo <url> --name <name>
```

Or trigger from another Render service in the same workspace (worker, web service) — the SDK auto-uses `RENDER_API_KEY` from the service's env.

## What this example doesn't ship (yet)

- **Web-service trigger.** The trigger flow is a CLI; for a true HTTP entrypoint, extend `@render-harness/web` to dispatch via `triggerAgentWorkflow` instead of pg-boss. The hook surface is there; the wiring is one optional opt away.
- **Slack notifications on pause.** The `onJobResult`-equivalent for workflows would be a Workflows event subscription that posts to Slack when a run reaches `awaiting_approval`. Out of scope for the deploy-agent demo.
- **Per-tool-call argument constraints.** The `requireApproval` allowlist gates by tool name only. Per-argument constraints (e.g. "auto-approve `render__update_web_service` only when `instanceCount` doesn't change") is plan v2.
