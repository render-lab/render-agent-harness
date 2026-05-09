# Architecture

The harness is a thin core wrapped by three runtime adapters (Cron, Worker, Workflows) running on Render primitives. Postgres holds state, Key Value holds ephemeral signals, MCP servers expose tools, and the model provider sits behind a swappable client.

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
| Ephemeral signals (cancel flags, locks) | Key Value | Single hop, low-latency reads |
| Streaming deltas | Postgres `agent_messages` row + LISTEN/NOTIFY pointer | NOTIFY 8 KB cap doesn't bite |

## Locked decisions (recap)

1. **Language: TypeScript.**
2. **No agent framework dependency.** No Vercel AI SDK, no Mastra, no Claude Agent SDK in the core.
3. **Model client: direct `@anthropic-ai/sdk` + `openai` SDKs** behind a thin `LLMClient` interface (Token.js rejected per Phase 0 verification 1).
4. **Three runtimes on shared core:** Cron, Worker, Workflows.
5. **State in Postgres, signals in KV.** No Redis dependency for state.
6. **Streaming via Postgres LISTEN/NOTIFY.** No Redis pub/sub.
7. **Pserv as default for production.** Demo mode collapses to a single web service.
8. **Default model: `claude-sonnet-4-7`** via Anthropic native. Override with `LLM_MODEL` env var.
9. **Agent definition format: TS object** via `defineAgent()`. Source of truth, versioned in git.
10. **MCP transport: stdio + Streamable HTTP** in v1. Render MCP runs over HTTP.
11. **Build order:** Cron → Worker → Workflows. Cron forces the runtime-agnostic core from day one.
