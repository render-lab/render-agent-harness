# Architecture

The harness is a thin core wrapped by four runtime adapters (Web, Cron, Worker, Workflows) running on Render primitives. Postgres holds state, Key Value holds ephemeral signals, MCP servers expose tools, and the model provider sits behind a swappable client. A separate config registry (`@render-harness/registry`) lets users package an entry as a declarative `render-harness.yaml`, with capability packs as the extension surface.

This document captures the architectural decisions and the Phase 0 verifications that confirmed (or adjusted) them. It's the source of truth for how the pieces fit together.

## Phase 0 verifications

These are the verifications from the execution plan, with findings. Adjustments to defaults are noted inline.

### 1. Token.js Anthropic adapter quality — REJECTED, fall back to direct SDKs

Token.js is the documented first choice for an OpenAI-format unified client across providers. Verification flagged it as not viable for v1:

- Last release: `0.7.1`, April 2025 (over a year stale as of build).
- Weekly downloads: under 1,000.
- Pinned dependencies: `@anthropic-ai/sdk@0.24.3` (current is `0.95.1`); `openai@4.91.1` (current is `6.x`).
- Cache control breakpoints, extended thinking, and the newer Anthropic tool-use shape would require either a fork or a bypass of the wrapped SDK.

**Decision (matches the plan's documented contingency):** drop Token.js. Use `@anthropic-ai/sdk` and `openai` directly behind a thin `LLMClient` interface in `@render-harness/core`. The OpenAI-compatible adapter still covers OpenRouter, Bedrock-via-LiteLLM, Vertex-via-LiteLLM, Groq, DeepSeek, Together, vLLM, Ollama, and any other OpenAI-format gateway by setting `baseURL`. Users who need Bedrock or Vertex *natively* in v1 can write a third adapter against the same interface.

### 2. Render Workflows step API

Source: official `render-workflows` skill and the linked SDK reference.

Confirmed:

- Run duration: up to 24 hours.
- Per-task timeout: 30s–86,400s, default 7,200s.
- Argument and return value size: 4 MB max per task invocation; must be JSON-serializable.
- Concurrent runs: 20–100 base depending on plan, expandable to 200–300.
- 500 task definitions per Workflow service.
- Instance types: `starter` (0.5 CPU / 512 MB) → `pro_ultra` (16 CPU / 32 GB).
- TS SDK is `@renderinc/sdk` with `render.workflows.startTask()` / `runTask()` / `cancel()` semantics.

**Caveat that adjusts the plan:**

- **Workflows are not yet supported in `render.yaml` Blueprints.** Workflow services must be created in the Dashboard. The deploy-agent example (Phase 4) ships with a Dashboard deploy checklist instead of a Blueprint snippet for the workflow service itself; the supporting web/worker services around it still ship as Blueprints.

**Adjustment to checkpoint defaults:** the `soft` checkpoint policy in core defaults to `maxSeconds: 6000` (100 min) so a single step comfortably stays inside the 7,200s default task timeout with margin for the model-call tail.

### 3. Postgres LISTEN/NOTIFY on Render Managed Postgres

Confirmed via Postgres documentation and Render's general support of Postgres extensions and notifications:

- LISTEN/NOTIFY is part of base PostgreSQL; no extensions required.
- NOTIFY payload limit is 8 KB (`MAX_NOTIFY_PAYLOAD`).
- Available on Managed Postgres; works through the standard `pg` client.

**Design decision:** the streaming protocol passes pointers (`(runId, messageId, kind)`) over NOTIFY, then the web service reads the row from `agent_messages` to forward over SSE. This keeps payloads tiny and avoids the 8 KB cap entirely.

### 4. Render private network for Postgres + pserv

Confirmed in Render docs and the relevant skills:

- Web services, workers, and private services share a private network within a project.
- Managed Postgres exposes both an internal hostname (`<db>.flycast`-style internal DNS) and an external hostname; using the internal hostname keeps DB traffic on the private network.
- Cron jobs can **send** to the private network but cannot **receive** inbound private-network traffic.
- Private services have no public surface; pserv-to-pserv DNS works inside the project.

**Design decision:** in private and hardened deployment modes, the worker pserv and MCP pservs all reach Postgres over the internal hostname. Only the public web service holds an external surface.

### 5. Render Cron job duration limits

Confirmed in the `render-cron-jobs` skill:

- Maximum run length per invocation: **12 hours**.
- Single-run guarantee: at most one active run per cron service at a time; a new tick will not start an overlapping run. Manual "Trigger Run" while active **cancels** the active run and starts a new one.
- No persistent disk on cron services.
- Schedule is UTC.
- Cron jobs cannot receive inbound private-network connections (outbound only).

**Adjustments to defaults in `runtime-cron`:**

- The default budget enforces `maxWallSeconds: 11 * 60 * 60` (11 hours) so the runtime exits before the platform kills it, allowing graceful flush of state to Postgres.
- The cron runtime documents that any agent expected to run longer than 11 hours must move to the Worker runtime.
- Cron is documented as a single-shot runtime: do not poll a queue inside a cron — use the Worker runtime for that.

## Component diagram

```
                    PUBLIC INTERNET
┌─────────────────────────┴──────────────────────────┐
│                                                    │
│  Web service (public, thin)                        │
│   - POST /runs, /runs/:id/stream                   │
│   - POST /runs/:id/cancel, /runs/:id/input         │
│   - Webhook receivers (Slack, Linear, GitHub)      │
│   - Auth, rate limit, tenant scoping               │
│                                                    │
└─────────────────────────┬──────────────────────────┘
                          │
                          │ enqueues run / publishes event
                          ▼
                  ╔═══════════════╗
                  ║ Render private║
                  ║   network     ║
                  ╠═══════════════╣
                  ║               ║
   ┌──────────────╬───────────────╬──────────────┐
   │              ║               ║              │
   ▼              ▼               ▼              ▼
┌──────┐     ┌─────────┐    ┌──────────┐   ┌───────────┐
│Worker│     │Workflows│    │ Postgres │   │ MCP pserv │
│pserv │     │ step    │    │ (private)│   │  cluster  │
│      │     │ handler │    │          │   │           │
└──┬───┘     └────┬────┘    └──────────┘   └─────┬─────┘
   │              │                              │
   └──────┬───────┘                              │
          │ MCP calls (private network)          │
          └──────────────────────────────────────┘
                         │
                         │ egress to model APIs only
                         ▼
              ┌──────────────────────┐
              │ Model provider       │
              │ (Anthropic, OpenAI,  │
              │  OpenRouter, etc.)   │
              └──────────────────────┘
```

## Three runtimes, one core

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENT DEFINITION                         │
│  defineAgent({ name, model, tools, skills, runtime: ... }) │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   workflows   │    │    worker     │    │     cron      │
│   runtime     │    │   runtime     │    │   runtime     │
│               │    │               │    │               │
│ HTTP trigger  │    │ Queue trigger │    │ Schedule      │
│ Step boundary │    │ Always-on     │    │ One-shot      │
│ Durable       │    │ Low latency   │    │ Idempotent    │
│ HITL-friendly │    │ Streaming     │    │ Batch         │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
        ┌─────────────────────────────────────────┐
        │           SHARED CORE                   │
        │  loop · adapter · MCP · skills · state  │
        │  prompt · tools · obs · cancellation    │
        └─────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   Postgres                  KV                MCP servers
```

## Core contract

The runtime calls one entry point. The core owns the loop, model adapter, MCP, state, skills, prompts, idempotency, and cancellation. The runtime owns "when to start" and "what to do with the result."

```ts
export async function runAgent(opts: {
  runId: string;
  agentDef: AgentDefinition;
  signal: AbortSignal;
  checkpoint: CheckpointPolicy;
  hooks?: RuntimeHooks;
}): Promise<RunStepResult>;
```

See [`packages/core/src/run.ts`](../packages/core/src/run.ts) for the full type signatures.

## State model

| Concern | Storage | Rationale |
|---|---|---|
| What happened (steps ran, retries, position) | Workflow run metadata | Owned by Render Workflows |
| What the work produced (messages, tool calls, results) | Postgres | Survives steps, deploys, and runtime swaps |
| Multi-turn grouping (chat sessions) | Postgres `agent_conversations` + nullable `conversation_id` on runs/messages | First-class thread the loop reads history from |
| Ephemeral signals (cancel flags, locks) | Key Value | Single hop, low-latency reads |
| Streaming deltas | Postgres `agent_messages` row + LISTEN/NOTIFY pointer | NOTIFY 8 KB cap doesn't bite |

### Conversations

Multi-turn chat is modelled as one `agent_conversations` row that owns many `agent_runs` rows. Each user turn enqueues a *new* run on the same `conversation_id`; the run loads message history with `loadConversationMessages(conversation_id)` so the model sees the full multi-turn context. Runs always end in a terminal state — `paused` means HITL only (`ask_user`, approval gates), never "waiting for the next user message."

- `conversation_id` is **nullable** on `agent_runs` and `agent_messages`. Single-turn web hits and cron one-shots don't synthesize singleton conversations — the column just stays null.
- `conversation_id` on `agent_messages` is denormalised (redundant with the run's value) so the loop's per-turn history load is a single indexed scan with no join.
- The **sequential-only invariant** is enforced by a unique partial index on `agent_runs(conversation_id) WHERE status IN ('pending','running','paused')`. `POST /conversations/:id/messages` returns 409 if a prior turn is in flight.
- The conversation's `total_cost_usd` and `last_active_at` are kept fresh inside `setRunStatus`: any flip on a conversation-bound run re-runs the rollup (SUM over the conversation's runs). Single source of truth — no per-caller bookkeeping.
- The NOTIFY pointer carries an optional `conversationId` so `GET /conversations/:id/stream` can fan in across every run in the conversation without joining `agent_runs` per event. The stream stays open across run boundaries — terminal status on one run does not close it.

See [`conversations-plan.md`](conversations-plan.md) for the design discussion and follow-up backlog (auto-generated titles, per-conversation rollups in `GET /usage`, branching).

## Locked decisions (recap)

1. **Language: TypeScript.**
2. **No agent framework dependency.** No Vercel AI SDK, no Mastra, no Claude Agent SDK in the core.
3. **Model client: direct `@anthropic-ai/sdk` + `openai` SDKs** behind a thin `LLMClient` interface (Token.js rejected per Phase 0 verification 1).
4. **Four runtimes on shared core:** Web, Cron, Worker, Workflows. (Web shipped in Phase 2.5.)
5. **State in Postgres, signals in KV.** No Redis dependency for state.
6. **Streaming via Postgres LISTEN/NOTIFY.** No Redis pub/sub.
7. **Pserv as default for production.** Demo mode collapses to a single web service.
8. **Default model: `claude-sonnet-4-6`** via Anthropic native (latest Sonnet as of build; Anthropic's Models API is the source of truth). Override with `LLM_MODEL` env var.
9. **Agent definition format:** TS object via `defineAgent()` is the canonical form. Registry entries may also use a YAML `render-harness.yaml` that either references a built-in agent kind (e.g. `chat`) or points at a TS entrypoint exporting an `AgentDefinition`. YAML is the deploy-time interface; TS remains the runtime contract.
10. **MCP transport: stdio + Streamable HTTP** in v1. Render MCP runs over HTTP.
11. **Build order:** Cron → Worker → Workflows. Cron forces the runtime-agnostic core from day one.

## Config registry

The harness ships a thin config registry that packages an entry as a small bundle: a declarative `render-harness.yaml` (model, MCP servers, capabilities, runtime topology, env schema), a committed `render.yaml` Blueprint, and optional TypeScript agent code. Two surfaces in [`packages/registry`](../packages/registry):

- A runtime library — `defineFromConfig()` reads `render-harness.yaml`, resolves capability packs from `node_modules`, and returns a runnable `AgentDefinition` ready for any runtime.
- A build bin — `npx render-harness-build` validates the YAML, runs the Blueprint emitter, and writes `render.yaml` next to the source. Authors run it once before committing.

Discovery and deployment intentionally have **no user-facing CLI**. A central [`registry-index/index.json`](../registry-index/index.json) lists entries by name + repo + commit-pinned SHA. End users browse a static discovery site and click a Deploy-to-Render badge in the entry's README. Render reads the committed `render.yaml`. This matches Render's existing Template Gallery flow.

The Blueprint emitter mirrors the shapes of the hand-authored Blueprints in [`blueprints/`](../blueprints/):

| `runtimes[]` combination | Output | Reference |
|---|---|---|
| `web` alone | Single web service + Postgres | [`render.demo.yaml`](../blueprints/render.demo.yaml) |
| `cron` alone | Cron service + Postgres | [`render.demo-cron.yaml`](../blueprints/render.demo-cron.yaml) |
| `web` + `worker` | Public web (multi-tenant shell) + worker pserv + Postgres + Key Value | [`render.private.yaml`](../blueprints/render.private.yaml) |
| `workflows` | Dashboard checklist (Workflows aren't yet Blueprintable; see verification 2) | n/a |

## Built-in tools

Every agent gets a default toolset from [`packages/core/src/builtins/`](../packages/core/src/builtins/), assembled by `buildBuiltinTools()` and concatenated with the agent's own `localTools` before the tool list reaches the model. Each builtin is a factory that decides at registration time whether its preconditions are met; tools whose env or harness preconditions aren't satisfied skip cleanly with a logged reason (operator UI surfaces this via `GET /agents`).

Three tiers:

| Tier | Always registers? | Tools |
|---|---|---|
| **A — always-on** | yes | `load_skill`, `fetch_full_result`, `fetch_url` (with SSRF guard), `current_time`, `ask_user`, `todo` |
| **B — env-gated** | only when env present | `web_search` (`EXA_API_KEY` → `TAVILY_API_KEY` → `BRAVE_API_KEY`), `web_extract` (`FIRECRAWL_API_KEY` → `EXA_API_KEY`), `image_generate` (`OPENAI_API_KEY` → `FAL_KEY`) |
| **C — harness-primitive-driven** | when the primitive is wired | `list_my_runs` (Postgres pool, scoped to caller `userId`) |

Override the Tier B provider chain with `HARNESS_WEB_SEARCH_PROVIDER=exa|tavily|brave`, `HARNESS_WEB_EXTRACT_PROVIDER=firecrawl|exa`, `HARNESS_IMAGE_PROVIDER=openai|fal`. Per-agent opt-out uses the existing `permissions.deniedTools` / `permissions.allowedTools`.

**Filesystem and terminal tools are deliberately NOT in core builtins.** The production worker pserv is multi-tenant — one Node process holds every tenant's env vars and runs against a shared filesystem. A core-default `read_file` would let a prompt-injected agent exfiltrate secrets from `/proc/self/environ` or read other tenants' uploaded data. Use the [`@render-harness/cap-filesystem`](../packages/capabilities/cap-filesystem/) pack for explicit, root-scoped, opt-in filesystem access.

## Extensibility (capability packs)

Three tiers of extension, each with a clean separation of concerns:

1. **MCP servers** (zero code). Declare them under `mcpServers[]` in `render-harness.yaml`. Works for any third-party MCP — Render MCP, Slack MCP, GitHub MCP, etc.
2. **Capability packs** (npm). Packages that default-export a `CapabilityPack` and contribute one or more of: `localTools`, `mcpServers`, `skills`, `envSchema`, `renderServices`. Tool / server names are namespaced as `<pack>.<thing>` so multiple packs coexist. First-party suite under [`packages/capabilities/`](../packages/capabilities/):
   - `cap-search-exa` — Exa MCP wiring + skill + env schema.
   - `cap-search-tavily` — Tavily MCP + skill + env.
   - `cap-scrape-firecrawl` — Firecrawl MCP + a `scrape_and_store` LocalToolHandler that persists to Postgres.
   - `cap-memory-pg` — long-term memory tools backed by `pg_trgm`. Pure TS; no extra service.
   - `cap-browser-browserbase` — Browserbase MCP wiring (hosted; no sidecar needed).
   - `cap-filesystem` — path-scoped `read_file` / `list_dir` / `write_file` / `delete_file`. Opt-in only.
3. **Custom TS** (full control). Any entry can declare `agent.kind: custom` with an `entrypoint` that default-exports an `AgentDefinition`. The YAML still drives Blueprint emission.

The community publishes packs to npm; entries reference them as regular `pnpm add` deps and list them under `capabilities[]`.

## Future runtimes

Voice / realtime is a planned fifth runtime with a different loop shape (bidirectional audio, OpenAI Realtime API or chained STT-LLM-TTS pipelines). It does not fit the existing tool-loop core. Tracked as a separate roadmap item; explicitly out of scope for the config registry.

A **per-run sandbox runtime** is on the table as a future direction — each run gets its own throwaway container (e2b / Daytona / Render-native primitive) instead of sharing the worker pserv's process. Once it lands, a `cap-sandbox-tools` pack can ship `terminal`, unscoped `read_file` / `write_file`, and arbitrary package installs as default tools, since per-run isolation makes them safe by construction. Until then those capabilities stay either out of the harness entirely (`terminal`) or in opt-in path-scoped packs (`cap-filesystem`).
