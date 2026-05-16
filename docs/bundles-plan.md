# Multi-agent bundles (schemaVersion 2)

## Context

Today every `render-harness.yaml` is **one agent per deployment**. A user who wants three agents (e.g. a chat assistant + meeting prep cron + weekly recap cron) has to run the wizard three times and pay for three full deployments — three Postgres instances, three KV stores, three web services. That's silly: the production stack is already multi-tenant (`@render-lab/web` keys runs by `agentName`, `runtime-worker` resolves agents from `job.agentName`, the SQL schema already has `agent_runs.agent_name`, the operator UI Chat tab already lets you switch agents). The single-agent assumption is purely a *manifest + scaffolder* limitation, not a runtime one.

This plan adds `schemaVersion: 2` to `render-harness.yaml` — a `agents: [...]` block that fans out to **one web + one worker + N cron services** (one Render Cron per distinct schedule, since Render's model is one schedule per service). Existing V1 manifests auto-upgrade in memory at load time; no gallery or example needs to change.

The headline deliverable is a **Chief of Staff** bundle — the wizard's first persona-shaped template: 3 agents (chat, meeting-prep, weekly-recap) sharing one harness, demonstrating multi-agent fan-out as the default UX story. After this lands, the gallery can keep growing with persona bundles (Interviewer, Site Watcher, Ops Copilot, etc.) without re-litigating the architecture.

**Out of scope for this plan** (deferred to follow-ups):
- "Add an agent to my existing harness" — the v2 wizard flow that mutates an existing managed repo. v1 wizard still produces fresh deploys.
- Multi-agent support in `runtime-web` (single-process demo) and `runtime-workflows`. Bundles always route through the production `packages/web` + `runtime-worker` + N `runtime-cron` shape.
- Per-queue worker isolation. Bundled `kind:worker` agents share one queue (`<bundle>-runs`); per-agent queues are a v3 concern for back-pressure isolation.

## Design

### Schema V2

`packages/registry/src/schema.ts` gains a `HarnessConfigSchemaV2` discriminated on `schemaVersion`. Shape:

```yaml
schemaVersion: 2
name: chief-of-staff
description: ...
harnessVersion: "^0.2"

# Bundle-wide; applies to every agent unless overridden.
shared:
  model: { provider, model }
  ui: true   # mount @render-lab/ui at /ui

# Bundle-wide capability packs. Packs are module-level singletons today
# (see `bootstrapped` in cap-memory-pg/src/index.ts:56), so per-agent
# capability blocks are not modeled — drop them.
capabilities:
  - pack: "@render-lab/cap-memory-pg"

agents:
  - id: chat
    description: ...
    agent: { kind: custom, entrypoint: ./src/chat.ts }
    runtimes: [{ kind: web }, { kind: worker }]
  - id: meeting-prep
    agent: { kind: custom, entrypoint: ./src/meeting-prep.ts }
    runtimes: [{ kind: cron, schedule: "*/15 * * * *" }]
  - id: weekly-recap
    agent: { kind: custom, entrypoint: ./src/weekly-recap.ts }
    runtimes: [{ kind: cron, schedule: "0 17 * * 5" }]

envSchema:
  - { name: ANTHROPIC_API_KEY, required: true, secret: true }
  - { name: CALENDAR_ICS_URL, required: false, secret: true }
```

Rules:
- `agents[].id` is a slug; unique within the bundle.
- The existing V1 "no duplicate runtime kind" `superRefine` (schema.ts:325-351) moves *inside each agent block* — one agent can't declare two `kind: web`. Cross-agent duplication is fine (becomes one coalesced service for web/worker, separate services for cron).
- `shared.model` is the bundle default. Per-agent `model:` override is allowed.
- `envSchema` is flat with naming-convention scoping (e.g. `MEETING_PREP_CALENDAR_URL`). Per-agent envSchema blocks were considered and rejected — env vars are free on Render and every service today sees the full set already (see `explicitEntryEnv` at `packages/registry/src/emitter.ts:380-393`).

### V1 → V2 normalization at load time

A new `normalizeToV2(raw)` runs inside `parseHarnessConfigYaml` and `defineFromConfig` (`packages/registry/src/load-config.ts:83-116`). It synthesizes a single-agent V2 from any V1 manifest: `id = config.name`, `runtimes` from top-level, `model` lifted to `shared.model`. **All downstream code (emitter, gallery cross-check, scaffolder, runtime registry) sees only V2 shape.** This is the cleanest migration — existing gallery entries and examples need zero edits.

### Emitter fan-out

`packages/registry/src/emitter.ts` rewrites the per-runtime loop (currently lines 89-194) to:

1. Group `agents[].runtimes` by kind across the bundle:
   - All agents with `kind: web` → **one** coalesced web service, importing every `web` agent's def, exposed via `serveWeb({ agents: {...} })`.
   - All agents with `kind: worker` → **one** coalesced worker (`startWorker({ agent: (job) => registry[job.agentName] })`). Uses today's existing resolver pattern at `packages/runtime-worker/src/index.ts:62`.
   - Each `kind: cron` entry → **one Render Cron service**, name `<bundle>-cron-<agentId>`, env `HARNESS_AGENT_ID=<id>`.
   - Each `kind: workflows` entry → one Dashboard checklist line per agent (today's behavior, fanned out).
2. Service names must be unique — collected and deduped before emission.
3. Env wiring (`sharedRuntimeEnv` line 341, `modelEnv` line 352, `kvFromService` line 367, `explicitEntryEnv` line 380) stays as-is; bundle services share the same env set.
4. Pack-merged envSchema (`mergeEnvSchemas` at `emitter.ts:399-425`) runs once at bundle level; packs already namespace by `ctx.entryName` via the cap-memory-pg pattern.

### Runtime changes

Single change: `packages/runtime-cron/src/index.ts`. Currently takes one `AgentDefinition` (line 45) and hardcodes `opts.agent.name` (line 90). Plan: alongside the existing single-agent API, add a `runCronFromRegistry({ registry, agentId, ... })` overload that selects via `Record<string, AgentDefinition>` lookup. The scaffolder emits `src/cron.ts` that calls this with `process.env.HARNESS_AGENT_ID`. No `if/else` chain — exact same pattern as `serveWeb`'s `resolveAgents` (`packages/web/src/index.ts:218`).

`runtime-worker` (`packages/runtime-worker/src/index.ts:62`) and `@render-lab/web` (`packages/web/src/index.ts:75-222`) need **zero changes** — already multi-agent.

### Scaffolder: sealed-bundle path

`packages/create-render-agent/src/generate.ts` `buildFileMap` (line 31-53) gains a second mode. Today it builds files from `Answers` (one agent, one prompt). For bundles:

- A bundle gallery entry on disk carries `render-harness.yaml` + `README.md` + a `src/` tree of TS sources (e.g. `gallery/agents/chief-of-staff/src/{chat,meeting-prep,weekly-recap}.ts`).
- `packages/create-render-agent/scripts/bundle-gallery.ts` is extended to inline that `src/` tree into `bundled-gallery/gallery.json` per entry. Today it only embeds the manifest and README (`packages/registry/src/gallery.ts:108-110`).
- `Answers` gains an optional `bundle?: { sourceFiles: Map<string, string>, sealed: true }` field.
- `buildFileMap` branches: if `answers.bundle` is set, it materializes the manifest + every embedded source file verbatim, **bypassing** the single-agent templating (`agent/index.ts`, `src/main.ts`, etc.). Single-agent path is untouched.
- The TTY wizard (`packages/create-render-agent/src/prompts.ts:35-145`) and the browser wizard (`packages/wizard/web/src/App.tsx`) detect a bundle pick and short-circuit the per-agent questions — bundles are sealed, the user only picks project name + fills env vars + optionally swaps `shared.model`.

### Gallery cross-check

`packages/registry/src/gallery.ts:186-196` cross-checks `index.yaml`'s `runtimeKinds` against `manifest.runtimes[].kind`. Update to a `flattenRuntimeKinds(manifest)` helper that unions across `agents[].runtimes` in V2 manifests. Existing per-agent gallery entries are unaffected (their normalized V2 form still has one agent).

### Chief of Staff bundle

`gallery/agents/chief-of-staff/`:

```
├── README.md
├── render-harness.yaml             # V2, 3 agents, shared cap-memory-pg
└── src/
    ├── chat.ts                     # conversation-backed chat agent
    ├── meeting-prep.ts             # cron, reads CALENDAR_ICS_URL via fetch_url
    └── weekly-recap.ts             # cron, summarises week from memory + sources
```

All three import `@render-lab/cap-memory-pg`; chat reads notes the cron agents wrote. `gallery/index.yaml` gets a new row with `runtimeKinds: ["web", "worker", "cron"]` and `categories: ["bundle", "personal"]`. A new `kind: "bundle"` discriminator on the gallery row tells the wizard to render the sealed flow.

Deploys to: 1 web + 1 worker + 2 Render Crons + Postgres + KV. The two cron services are `chief-of-staff-cron-meeting-prep` and `chief-of-staff-cron-weekly-recap`.

## Phased rollout

Each phase is a self-contained PR that leaves main green.

1. **Schema V2 + normalizer** (`packages/registry/src/schema.ts`, `load-config.ts`, `schema.test.ts`). Lands V2 alongside V1; normalizer collapses V1 in memory; all existing tests still pass. Roughly 1-2 days.
2. **Emitter fan-out** (`packages/registry/src/emitter.ts`, `emitter.test.ts`). Walks normalized V2 agents, coalesces web/worker, fans cron. New snapshot tests for the multi-agent emit. 2-3 days.
3. **runtime-cron registry mode** (`packages/runtime-cron/src/index.ts`). New `runCronFromRegistry` overload + tests. 1 day.
4. **Scaffolder sealed-bundle path** (`packages/create-render-agent/src/generate.ts`, `prompts.ts`, `scripts/bundle-gallery.ts`, `bundled-gallery/`). 2-3 days.
5. **Gallery cross-check + bundle discriminator** (`packages/registry/src/gallery.ts`, `gallery.test.ts`, `gallery/index.yaml` schema). 0.5 day.
6. **Chief of Staff bundle** (`gallery/agents/chief-of-staff/`). System prompts, three agent defs, README, bundled-gallery rebuild. 2-3 days.
7. **Browser wizard bundle UI** (`packages/wizard/web/src/steps/`, `packages/wizard/src/routes/scaffold.ts`). Bundle-aware Template step + collapsed remaining steps. 1-2 days.
8. **Docs** (`docs/gallery-plan.md` update, `docs/bundle-authoring.md` new). 1 day.

Realistic total: **2.5-3 weeks** of focused work. Phases 1-3 can land before any user-facing change; phase 6-7 is the headline ship.

## Files to modify

| File | Change |
|---|---|
| `packages/registry/src/schema.ts` | Add `HarnessConfigSchemaV2`, discriminated parse, V1→V2 normalizer |
| `packages/registry/src/load-config.ts:83-116` | Iterate `agents[]`; call `resolveAgentBlock` per agent; return `{ agents: AgentDefinition[], config, packs }` |
| `packages/registry/src/emitter.ts:89-194` | Per-kind fan-out (coalesce web/worker, N cron services) + unique service naming `<bundle>-<kind>[-<agentId>]` |
| `packages/registry/src/gallery.ts:186-196` | `flattenRuntimeKinds` union across agents |
| `packages/registry/src/index.ts:31` | `DefineFromConfigResult.agent → agents[]` (breaking — but only one downstream consumer outside the package) |
| `packages/runtime-cron/src/index.ts:44-95` | Add `runCronFromRegistry({ registry, agentId })` overload |
| `packages/create-render-agent/src/generate.ts:31-53` | Sealed-bundle branch in `buildFileMap` |
| `packages/create-render-agent/src/prompts.ts:35-145` | Detect bundle pick; collapse per-agent questions |
| `packages/create-render-agent/scripts/bundle-gallery.ts` | Inline bundle `src/` trees into `gallery.json` |
| `packages/wizard/web/src/steps/Template.tsx` | Render bundle entries differently (badge + agents preview) |
| `packages/wizard/src/routes/scaffold.ts:96-110` | Wire `bundle.sourceFiles` into Answers when a bundle is picked |
| `gallery/agents/chief-of-staff/` (new) | Manifest + 3 agent defs + README |
| `gallery/index.yaml` | New row with `kind: bundle` discriminator |

## Existing functions/utilities to reuse

- `packages/runtime-worker/src/index.ts:62` — agent resolver `(job) => AgentDefinition` already present; bundles use it as-is
- `packages/web/src/index.ts:218` — `resolveAgents` already returns a `Record<string, AgentDefinition>` for the agents map; the coalesced web service uses this verbatim
- `packages/web/src/routes/agents.ts:15` — `GET /agents` already enumerates a live map; UI bundle support is free
- `packages/ui/web/src/tabs/ChatTab.tsx:31-44` — agent switcher already exists
- `packages/registry/src/capability.ts` + `load-pack.ts` — capability resolution stays bundle-level (packs are module singletons, not per-agent)
- `packages/registry/src/builtin-chat.ts:45-57` — `defineChatAgent` reused per agent that uses `kind: builtin`
- `packages/create-render-agent/src/generate.ts:buildFileMap` — pure function reused as-is for non-bundle templates

## Verification

End-to-end smoke (run after phase 6):

```sh
pnpm build
pnpm test                    # all phases keep existing tests green; new tests added per phase

# CLI flow
node packages/create-render-agent/dist/bin.js \
  --template chief-of-staff --dir /tmp/cos --no-install --no-git
# Expect: /tmp/cos/render-harness.yaml is V2 with 3 agents,
#         /tmp/cos/src/{chat,meeting-prep,weekly-recap}.ts exist verbatim from gallery.

# Blueprint emit
pnpm --filter @render-lab/registry exec node bin/build.ts /tmp/cos
# Expect render.yaml with: 1 web, 1 worker, 2 cron services (cron-meeting-prep, cron-weekly-recap),
#         1 pg, 1 KV, env vars merged once. Service names unique.

# Local boot (multi-tenant production shape)
pnpm db:up
HARNESS_AGENT_ID=meeting-prep node /tmp/cos/dist/cron.js   # one-shot, exits 0
node /tmp/cos/dist/web.js &                                 # serves chat at :8080
curl :8080/agents                                           # returns [{name:"chat"}] (the only web-runtime agent)
curl -X POST :8080/runs -d '{"agentName":"chat","input":"what is on tomorrow?"}'

# UI flow (operator UI)
pnpm dev:operator-web
# Expect: Chat tab shows agent picker with "chat" (the meeting-prep + weekly-recap agents are cron-only,
#         correctly absent from the picker — they're scheduled).

# Browser wizard
pnpm --filter @render-lab/wizard dev
# Pick "Chief of Staff" template → expect collapsed step flow (no per-agent prompts),
# project name + env step only → Create → managed repo contains all 3 source files.
```

Unit tests added per phase:

- `schema.test.ts` — V1 parse still works; V1→V2 normalization output identity; V2 multi-agent parse; per-agent runtime-kind duplication rejected.
- `emitter.test.ts` — snapshot: 3-agent bundle emits 1 web + 1 worker + 2 cron + db + kv; service names unique; env merged once.
- `gallery.test.ts` — bundle entry with `kind: bundle` parses; cross-check passes when `runtimeKinds` is the union.
- `runtime-cron` test — `runCronFromRegistry` resolves by `HARNESS_AGENT_ID`, errors clearly when id absent.
- `create-render-agent` snapshot — sealed-bundle scaffold produces exact file list verbatim from `gallery.json`.

## Open questions resolved during execution

1. **`shared.model` vs per-agent `model`** — override path kept. Bundles can mix Sonnet for chat with Haiku for cheap crons; the emitter's `mergeEnvSchemas` collects api keys for every referenced provider.
2. **Bundle slug in `agent_runs.agent_name`** — rows get the bare `agent.id`. Bundles each get their own Postgres in v1, so collisions are impossible. Documented in `bundle-authoring.md`.
3. **Wizard "blank" template** — stays single-agent. The bundle path is only entered when the user picks a `kind: "bundle"` gallery entry.

## Cron + Workflows hybrid (post-v1 addendum)

Shipped after the initial 8 phases. The bundle scheduling model evolved from "one Render Cron service per `kind: cron` runtime" to a three-mode story driven by the runtime block's `via` discriminator and an explicit `workflowTask` flag on the agent. Full design in [`cron-workflows-plan.md`](./cron-workflows-plan.md); a per-mode quick reference + authoring guidance lives in [`bundle-authoring.md`](./bundle-authoring.md).

The three modes:

| Mode | Manifest | What deploys | Use when |
|---|---|---|---|
| **Cron, inline** | `kind: cron` (default; `via: cron` implicit) | One Render Cron service running `dist/cron.js` (the agent loop, exits on success). | Short fail-stop work with no HITL. e.g. `meeting-prep` — 15-min cadence, ~30s of work. |
| **Cron, triggers workflow** | `kind: cron`, `via: workflow` (implies `workflowTask: true`) | A thin Render Cron service running `dist/cron-trigger.js` that calls `render.workflows.runTask` and exits in ~100ms. The actual agent run executes in the bundle's Workflow service. | Periodic durable / observable / HITL-capable work. e.g. `weekly-recap` — weekly, multi-step, may pause for approval. |
| **Workflow-only, agent-triggered** | `workflowTask: true` (no cron) or legacy `kind: workflows` | No extra Render service. The agent is registered as a task on the bundle's single Workflow service and is callable from other agents via `trigger_workflow`. | On-demand durable work. e.g. chat agent invokes a `deep-research` workflow when the user asks. |

A single agent can combine modes (declared once, exposed multiple ways).

### Architecture facts

- **One Workflow service per bundle** hosts every workflow-mode agent as one task. Render allows up to 500 tasks per service; one service is plenty for any realistic bundle.
- **Tasks auto-register on service boot** — pushing a new agent file = a new task on next deploy. No API call needed for task registration.
- **The Workflow service is not Blueprintable** — created from the Render Dashboard once per bundle. The emitter prints a single consolidated checklist line ("Create `<bundle>-workflows`, link this repo, register these tasks: …"). A future `render-harness workflows sync` CLI will automate this via the Render API, but is deferred.
- **`trigger_workflow` is a new Tier-B builtin** in `@render-harness/core`. Env-gated by `RENDER_API_KEY` + `WORKFLOW_SLUG` (both wired automatically by the emitter on web/worker services when the bundle has any workflow-task agent). Wraps `triggerAgentWorkflow` from `runtime-workflows` so triggered runs pre-create their `agent_runs` row — unified observability with web/worker/cron runs.

### Extensibility from the agent interface

Because a Workflow service auto-registers every `task()` call on boot, the architecture supports **agents authoring other agents**:

1. A chat agent (with filesystem + git capability packs) writes a new `src/<new-agent>.ts` to the bundle repo.
2. Commits + pushes to the linked repo.
3. Render auto-rebuilds the Workflow service (~30s).
4. The new task is registered on next boot and immediately callable via `trigger_workflow({ agent: "<new-agent>" })`.

No infrastructure changes per agent. The same pattern works for adding new `via: workflow` cron entries (the cron service is also redeployed on push).
