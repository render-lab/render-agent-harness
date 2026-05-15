# Cron + Workflows hybrid for V2 bundles

## Context

The initial bundle work (see [`bundles-plan.md`](./bundles-plan.md)) emitted one Render Cron service per `kind: cron` runtime entry. That works but is wrong for two cases:

1. **Long-running or HITL-capable scheduled work.** Cron jobs have no native pause/resume, no per-step observability, and no approval gates. A weekly-recap that runs for an hour and optionally waits for user approval before writing to memory is a *Workflow* shape, not a *cron* shape.
2. **Operational sprawl.** Each scheduled agent becomes its own Render service tile, build artifact, log stream, and deploy pipeline.

This plan introduces a three-mode scheduling story for V2 bundles, plus a `trigger_workflow` built-in tool that lets any agent invoke a workflow-mode sibling on demand.

The architecture is also **extensible from the agent interface**: an agent with filesystem + git capability packs can author new agent files, push to the linked repo, and the bundle's Workflow service auto-registers the new tasks on rebuild. No new infrastructure per agent.

### Render Workflows facts that anchor the design

- **One Workflow service can host up to 500 tasks.** A bundle gets *one* Workflow service total; each workflow-mode agent is one task.
- **Tasks auto-register on service boot** from `task({ name }, fn)` calls. New code → new tasks, no API call.
- **Task identifier: `{workflow-slug}/{task-name}`.** Slug = Render service slug; task-name = SDK registration name.
- **Workflows have no built-in scheduling.** Schedule = a Render cron job that calls `render.workflows.runTask(...)`.
- **Cross-workflow calls** use the same SDK primitive; `trigger_workflow` is a thin wrapper.
- **Workflow services are not Blueprintable.** Created from the Render Dashboard once per bundle. A future `render-harness workflows sync` CLI will automate this; until then, the emitter prints a consolidated Dashboard checklist line.

## The three modes

| Mode | Manifest | Deploys to | Use case |
|---|---|---|---|
| **Cron, inline** | `kind: cron` (default; `via: cron` implicit) | One Render Cron service running `dist/cron.js` (the agent loop). | Short, fail-stop, no HITL. e.g. `meeting-prep`. |
| **Cron, triggers workflow** | `kind: cron`, `via: workflow` (implies `workflowTask: true`) | A thin Render Cron service running `dist/cron-trigger.js` that calls `render.workflows.runTask`. Workflow task hosts the actual run. | Periodic durable / observable / HITL work. e.g. `weekly-recap`. |
| **Workflow-only, agent-triggered** | `workflowTask: true` (legacy: `kind: workflows`) | No extra Render service. Registered as a task on the bundle's single Workflow service. Triggered by another agent or external system. | On-demand durable work. e.g. `deep-research` invoked from chat. |

A single agent can combine modes — declared once, exposed multiple ways.

## Schema (`packages/registry/src/schema.ts`)

Two additions, both backward-compatible:

```ts
// AgentEntrySchema
workflowTask: z.boolean().optional()

// RuntimeCronSchema
via: z.enum(["cron", "workflow"]).optional()  // default "cron"
```

Two helpers exported from `@render-harness/registry`:

```ts
isWorkflowTaskAgent(agent: AgentEntryInput): boolean
workflowTaskAgents(cfg: HarnessConfigV2): AgentEntryInput[]
```

An agent is a workflow task when `workflowTask: true` is explicit OR any runtime is `kind: workflows` OR any `kind: cron` is `via: workflow`.

## Emitter (`packages/registry/src/emitter.ts`)

Three changes:

1. **Split the cron loop on `via`.** `via: cron` → today's `cronService()`. `via: workflow` → new `cronTriggerService()` (start command `dist/cron-trigger.js`, env vars `WORKFLOW_TASK_REF`, `WORKFLOW_SLUG`, `RENDER_API_KEY`, no model env).
2. **Compute the workflow-task agent set** via `workflowTaskAgents(cfg)`. If non-empty, emit **one** consolidated dashboard checklist step listing the tasks:
   > Create one Render Workflow service named `<bundle>-workflows`, link this repo, set build/start commands … It will host these tasks: `task-a`, `task-b`, …
3. **Wire `WORKFLOW_SLUG` + `RENDER_API_KEY`** into web and worker envs when the bundle has any workflow-task agent — so the `trigger_workflow` builtin registers in those services.

## New built-in tool: `trigger_workflow`

`packages/core/src/builtins/triggerWorkflow.ts`. Tier B, env-gated by `RENDER_API_KEY` + `WORKFLOW_SLUG`.

```ts
// Input
{ agent: string, input?: string | object, await?: boolean, metadata?: object }
// Output (returned as JSON in the tool result)
{ taskRef: string, runId: string, taskRunId: string, status?: string, results?: unknown }
```

Implementation:
- Composes `taskRef = ${WORKFLOW_SLUG}/${agent}`.
- Wraps `triggerAgentWorkflow` from `@render-harness/runtime-workflows` (dynamic import — avoids a `core ↔ runtime-workflows` layering cycle). Pre-creates an `agent_runs` row so workflow-triggered runs show up in our SQL state alongside web/worker/cron runs.
- Returns the new run id + workflow task run id immediately. If `await: true`, blocks until the workflow finishes and returns results.

Permission-gated like any builtin. `permissions.requireApproval: ["trigger_workflow"]` puts a HITL gate in front of every agent-initiated workflow run — the user explicitly approves each delegation.

## Scaffolder (`packages/create-render-agent/src/templates/bundle.ts`)

New template helpers:

- **`bundleCronTriggerEntry()`** — generates `src/cron-trigger.ts`. Reads `WORKFLOW_TASK_REF` + `HARNESS_AGENT_ID`, calls `triggerAgentWorkflow`, exits.
- **`bundleWorkflowsEntry()`** — generates `src/workflows.ts`. Loads the bundle, iterates `config.agents`, and registers each workflow-task agent as `task({ name: agent.id }, ...)`. Self-recurses on checkpoint.
- **`bundlePackageJson`** extensions — wires `@renderinc/sdk` + `@render-harness/runtime-workflows` when any workflow-task agent is present. Bundles without workflow tasks pay no extra deps.

`buildBundleFileMap` adds `src/cron-trigger.ts` when any `via: workflow` cron exists, and `src/workflows.ts` when any workflow-task agent exists. Inline-cron-only bundles ship `src/cron.ts` as before.

## Chief of Staff (post-revamp)

```yaml
agents:
  - id: chat
    runtimes: [{ kind: web }, { kind: worker }]
    permissions:
      requireApproval: ["trigger_workflow"]   # HITL on chat-initiated workflows

  - id: meeting-prep                          # inline cron — short fail-stop
    runtimes: [{ kind: cron, schedule: "*/15 * * * *" }]

  - id: weekly-recap                          # cron-triggered workflow
    workflowTask: true
    runtimes:
      - kind: cron
        schedule: "0 17 * * 5"
        via: workflow
```

Deploys to:
- 1 Postgres, 1 Key Value, 1 web, 1 worker pserv
- 1 inline cron (`chief-of-staff-cron-meeting-prep`)
- 1 cron-trigger (`chief-of-staff-cron-trigger-weekly-recap`)
- 1 Workflow service (`chief-of-staff-workflows`) hosting one task: `weekly-recap` — Dashboard-created

Total: 5 Blueprint services + 1 Dashboard click. Same Blueprint footprint as before, with `weekly-recap` now durable and HITL-capable.

## Status

| Phase | State |
|---|---|
| 1. `trigger_workflow` builtin | **Done** — 3 new tests in `registry.test.ts` |
| 2. Schema `workflowTask` + `via` | **Done** — 6 new helper tests |
| 3. Emitter cron-trigger + workflow checklist | **Done** — 3 new emit tests |
| 4. Scaffolder cron-trigger + workflows entries | **Done** — 4 new bundle tests |
| 5. Chief of Staff revamp | **Done** — e2e test verifies the new shape |
| 6. Docs | **Done** — this doc + updates to `bundle-authoring.md` |
| 7. `render-harness workflows sync` CLI | Deferred — Dashboard checklist is the manual path |

## Verification

```sh
pnpm build && pnpm test                # all 23 packages green

# Schema
pnpm --filter @render-harness/registry test -- -t "workflowTask"
pnpm --filter @render-harness/registry test -- -t "via:.workflow"

# Emitter (chief-of-staff fan-out)
pnpm --filter @render-harness/registry test -- -t "cron-trigger"

# Builtin
pnpm --filter @render-harness/core test -- -t "trigger_workflow"

# E2E scaffold from the real gallery
pnpm --filter create-render-agent test -- -t "chief-of-staff bundle"
# Expected files include: src/cron.ts (meeting-prep inline),
#   src/cron-trigger.ts (weekly-recap trigger),
#   src/workflows.ts (registers weekly-recap as a Workflow task).
```

## Future work

- **`render-harness workflows sync` CLI** (Phase 7). Uses the Render API to create/update the bundle's Workflow service post-deploy. Stores Workflow IDs in a `.render-workflows.lock.json` for idempotent re-syncs. May reduce to "shell out to `render workflows init`" depending on what the existing Render CLI supports.
- **`workflowGroup`** field — spread tasks across N Workflow services for failure isolation or per-group plan sizing. Deferrable; v1 sticks with one Workflow service per bundle.
