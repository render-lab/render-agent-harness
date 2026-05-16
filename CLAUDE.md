# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo shape

pnpm workspace, Node 22+, pnpm 10+ (`packageManager` is pinned via corepack). TypeScript end-to-end, ESM only, `verbatimModuleSyntax` and `exactOptionalPropertyTypes` are on — imports of types must use `import type`, and optional fields differ from `| undefined`. Workspace globs: `packages/*`, `packages/capabilities/*`, `examples/*`. Each package builds with `tsup` to `dist/` and tests with `vitest`.

## Commands

Run from the repo root unless noted:

```sh
pnpm install                 # one-time
pnpm build                   # builds packages/* then examples/*
pnpm typecheck               # tsc --noEmit across the workspace
pnpm test                    # vitest run across the workspace
pnpm check                   # biome (lint + format, read-only)
pnpm check:fix               # biome --write --unsafe
pnpm lint / pnpm lint:fix    # biome lint only
pnpm format                  # biome format --write
```

Single-package operations use pnpm filter syntax:

```sh
pnpm --filter @render-harness/core test
pnpm --filter @render-harness/core test -- src/loop.test.ts        # one file
pnpm --filter @render-harness/core test -- -t "cancellation"       # one test by name
pnpm --filter @render-harness/core typecheck
pnpm --filter @render-harness/core build
```

Local primitives stack (Postgres 17 + Valkey 8) — most tests and all integration paths require it:

```sh
pnpm db:up        # 127.0.0.1:55432 (pg), 127.0.0.1:56379 (valkey)
pnpm db:psql      # psql in the postgres container
pnpm db:valkey    # valkey-cli in the valkey container
pnpm db:reset     # nuke volumes and start fresh
pnpm db:down
```

If those host ports are taken: `HARNESS_PG_PORT=15432 HARNESS_KV_PORT=16379 pnpm db:up`.

End-to-end example runners:

```sh
pnpm dev:web                                        # examples/web-chat (runtime-web)
pnpm dev:citations                                  # examples/citations-monitor (runtime-cron)
pnpm dev:operator-web / pnpm dev:operator-worker    # examples/operator-demo
pnpm --filter @render-harness/example-support-agent dev:worker / dev:web
pnpm --filter @render-harness/example-deploy-agent dev:workflow      # needs render CLI
```

Cancel a running agent from another shell: `pnpm db:valkey` then `SET cancel:<run-id> user_requested EX 3600`. The cron runtime polls this flag every 500 ms between turns and tool calls; the worker checks it at the same boundaries.

## Architecture: thin core, four runtimes

A single `runAgent({ runId, agentDef, signal, checkpoint, hooks }, { pool, logger, ... })` entry point in `@render-harness/core` owns the loop, model adapter, MCP, state, skills, prompt assembly, idempotency, and cancellation. Runtimes only decide *when* to start and *what to do with the result* — they never read history or call the model directly.

| Runtime package | Trigger | Shape |
|---|---|---|
| `runtime-web` | HTTP request handler | Sub-30s synchronous, demo-mode default |
| `runtime-cron` | Render Cron schedule | One-shot, 11h budget (12h platform cap minus margin) |
| `runtime-worker` | pg-boss queue consumer | Always-on, low-latency, streaming, multi-tenant prod default |
| `runtime-workflows` | Render Workflows task | Durable, HITL approvals as subtasks; `soft` checkpoint defaults to 6000s to fit the 7200s task timeout |

On top of `runtime-worker`, `@render-harness/web` exposes the public HTTP/SSE surface (`POST /runs`, `GET /runs/:id/stream`, `POST /runs/:id/cancel|input`, `GET /runs`, `GET /agents`, `GET /usage`) and `@render-harness/ui` mounts an opt-in operator SPA at `/ui` (`serveWeb({ ui: true })`). The web/ui split is deliberate — all HTTP routes live in `web`; `ui` is browser assets + a cookie-session helper.

## State, signals, streaming

| Concern | Where | Why |
|---|---|---|
| Run state, messages, tool calls, full results | Postgres (`agent_runs`, `agent_messages`, `agent_tool_calls`, `agent_tool_results`) — schema in `packages/core/sql/0001_init.sql` | Survives steps, deploys, runtime swaps |
| Cancellation flags, locks | Key Value (Valkey/Redis-compatible) at `cancel:<runId>` | Single-hop, low-latency reads |
| Streaming deltas | Postgres `agent_messages` row + `LISTEN/NOTIFY agent_runs` | NOTIFY's 8 KB cap doesn't bite — the payload is just `(runId, messageId, kind)` |

Per-run message `seq` is allocated atomically by the `agent_next_seq(run_id)` SQL function — call it inside the same transaction as the message insert, never client-side.

Tool results are stored in full in `agent_tool_results.content`; a truncated copy (`DEFAULT_MAX_RESULT_TOKENS`, ~2000 tokens) goes back into the model context. The builtin `fetch_full_result` tool lets the model retrieve the untruncated payload on demand.

## Built-in tools (auto-loaded)

`buildBuiltinTools()` in `packages/core/src/builtins/` is concatenated with each agent's `localTools` before tools reach the model. Three tiers:

- **Tier A — always on:** `load_skill`, `fetch_full_result`, `fetch_url` (SSRF guard blocks loopback / private / link-local / cloud-metadata IPs, 1 MB cap, 15s timeout, 3-redirect cap), `current_time`, `ask_user` (pauses run via `AwaitingInputError`; resumes through `POST /runs/:id/input`), `todo`.
- **Tier B — env-gated provider chains:** `web_search` (`EXA_API_KEY` → `TAVILY_API_KEY` → `BRAVE_API_KEY`), `web_extract` (`FIRECRAWL_API_KEY` → `EXA_API_KEY`), `image_generate` (`OPENAI_API_KEY` → `FAL_KEY`). Override the chain via `HARNESS_WEB_SEARCH_PROVIDER`, `HARNESS_WEB_EXTRACT_PROVIDER`, `HARNESS_IMAGE_PROVIDER`.
- **Tier C — primitive-driven:** `list_my_runs` (Postgres, hard-scoped to the caller's `userId`).

A skipped builtin (missing env, missing primitive) is recorded in `agent_runs.metadata.skippedBuiltins` and surfaced via `GET /agents`. Per-agent opt-out via `permissions.deniedTools` / `permissions.allowedTools`.

**Filesystem and terminal tools are deliberately not in core builtins** because the production worker pserv is multi-tenant — one Node process holds every tenant's env vars. Use `@render-harness/cap-filesystem` for path-scoped opt-in access.

## Locked decisions (don't relitigate in PRs)

1. TypeScript end-to-end. No agent framework dependency — direct `@anthropic-ai/sdk` + `openai` SDKs behind `LLMClient` (Token.js was rejected — see `docs/architecture.md` Phase 0 verification 1).
2. Four runtimes on a shared core. Cron came first to force the runtime-agnostic core.
3. State in Postgres, signals in KV, streaming via LISTEN/NOTIFY. **No Redis dependency for state or pub/sub.**
4. Private services as the production default; demo mode collapses to one web service.
5. MCP for tools — both stdio and Streamable HTTP supported in v1. Render MCP runs over HTTP.
6. Default model is `claude-sonnet-4-6`; override with `LLM_MODEL`.
7. `defineAgent()` (TS) is the canonical agent format. Registry's `render-harness.yaml` is the deploy-time interface; it either references a built-in agent kind or points at a TS entrypoint.
8. Workflows are not yet supported in `render.yaml` Blueprints. Workflow services are created in the Dashboard; surrounding web/worker services still ship as Blueprints.

## Conventions worth knowing

- `noUnusedImports` is `error` in Biome. `noConsole` warns except for `error`/`warn`/`info` — `main.ts`, `cli.ts`, and `scripts/**` are exempt. `noExplicitAny` warns; tests are exempt.
- All code is ESM with explicit `.js` extensions in import paths even when the source is `.ts` — required by `module: "NodeNext"`. Type-only imports must use `import type` (`useImportType` is `error`).
- `core` exports its public surface from `packages/core/src/index.ts` — when adding new public symbols, export them there or runtime adapters won't see them.
- The cron runtime's default budget caps wall time at 11 hours so it can flush state before the platform's 12-hour kill. Cron is single-shot — never poll a queue inside a cron, use the worker runtime.
- Multi-turn chat is conversation-backed: create an `agent_conversations` row and enqueue each user turn as a new run with `conversationId`. Runs complete normally; `paused` is reserved for HITL (`ask_user`, approval gates).
