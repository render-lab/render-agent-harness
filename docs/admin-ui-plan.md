# Admin UI: in-process config plane for deployed agents

## Context

The operator UI at `/ui` (served by `@render-harness/ui` and mounted from `@render-harness/web` via `serveWeb({ ui: true })`) is read-only today. `packages/ui/web/src/tabs/AgentsTab.tsx` renders the system prompt, MCP server list, permissions, and budgets as inert text. The only way to change any of it is to edit `render-harness.yaml` and restart the service: `defineFromConfig({ configPath })` in `packages/registry/src/load-config.ts` runs once at boot and the resulting `AgentDefinition` is captured in a `Record<string, AgentDefinition>` that web routes and the worker close over.

This plan turns that read-only surface into an admin/config plane for a *deployed, running* agent. After this lands, an authenticated operator can:

1. Edit the system prompt and switch the model from the UI.
2. Enable/disable capability packs declared in `render-harness.yaml`.
3. Toggle individual local tools and per-server MCP tools.
4. Manage skills (load/unload, view metadata).
5. View and edit schedules — both the YAML-declared `runtime-cron` schedule (read-only with a "redeploy required" badge in v1) and ad-hoc, chat-creatable scheduled runs (full CRUD, from `docs/recurring-tasks-plan.md`).

**Distinction from `docs/onboarding-plan.md` Phase 3.** That phase builds a *no-code wizard for scaffolding a new project from scratch*: managed repo, Render bot commits, graduate-to-GitHub. This plan is the opposite end of the lifecycle — it manages the *running* agent in a service that's already deployed. The two surfaces will eventually share form widgets (model picker, tool checkboxes), but the artifacts they produce are different: the wizard writes `render-harness.yaml` files into a new repo; the admin UI writes overlay rows in the deployed service's Postgres.

### Decided forks (from design discussion)

These are locked for v1 — referenced in §3 but not relitigated:

1. **Persistence: DB overlay.** A new `agent_config_overlay` table layers on top of `render-harness.yaml`. YAML is the *seed*; overlay is the *live truth*. `defineFromConfig` is extended to merge overlay rows on boot, and a getter API exposes the merged shape to runtime adapters. A future "promote overlay → YAML" export path is out of scope for v1 (see §6).
2. **Hot-reload via getter.** `runtime-worker` already accepts `agent` as a `(job) => AgentDefinition` resolver function (`packages/runtime-worker/src/index.ts:62`). We exploit that: the resolver returns the latest merged definition every call. Web routes get a similar `getAgent(name)` getter. A `pg_notify('agent_config_changed', name)` channel invalidates an in-process cache so multi-instance fleets stay in sync. In-flight runs keep their old config; the next run / next request reads fresh.
3. **Scheduling scope: both.** YAML-declared cron runtimes show as read-only with a `redeploy required` badge, since the cron expression lives in the Render Cron service spec and changing it means changing `render.yaml`. Ad-hoc scheduled runs (the `agent_schedules` table from `docs/recurring-tasks-plan.md`) get full CRUD via the admin UI.
4. **Auth.** v1 reuses the existing cookie-session + API-key flow — `WEB_API_KEY` holder == admin. No separate admin role. A `requireAdmin` flag on the auth resolver is added so individual admin routes can tighten later without re-architecting.
5. **Audit.** Lightweight — every overlay write inserts a row in `agent_config_edits` (one new table, no separate service). Not surfaced in the UI in v1; queryable via psql.

## Dependencies

Two adjacent plans interact with this work; landing order matters:

- **`docs/recurring-tasks-plan.md`** introduces the `agent_schedules` table, the five `schedule_*` builtins, and the worker's pg-boss reconciler. The admin UI's scheduling tab is a thin read/write surface over those primitives. If recurring-tasks ships first, this plan adds web routes + UI; if it ships *after* this plan, the schedules tab degrades to "show YAML cron-runtime, hide ad-hoc". Recommend landing recurring-tasks first; nothing in this plan blocks on it for the other four features (prompt, model, tools, skills).
- **Conversations / `docs/conversations-plan.md`** has already landed (`packages/core/sql/0002_conversations.sql`). No new dependency.

Nothing else blocks. The plan does *not* depend on `docs/cli-scaffolder-plan.md` or `docs/connectors-plan.md`.

## Architecture

### Persistence model — `agent_config_overlay`

A single new migration `packages/core/sql/0004_agent_config_overlay.sql`:

```sql
CREATE TABLE agent_config_overlay (
  agent_name      text PRIMARY KEY,
  system_prompt   text,
  model           jsonb,                 -- { provider, model, baseURL?, apiKeyEnv?, thinking? }
  sampling        jsonb,                 -- partial { temperature, topP, maxOutputTokens }
  budget          jsonb,                 -- partial Budget
  permissions     jsonb,                 -- { allowedTools?, deniedTools?, requireApproval? }
  capability_state jsonb NOT NULL DEFAULT '{}'::jsonb,
                  -- { "<pack>": { enabled: bool, toolEnabled?: { "<tool>": bool } } }
  mcp_state       jsonb NOT NULL DEFAULT '{}'::jsonb,
                  -- { "<server>": { enabled: bool, toolEnabled?: { "<tool>": bool } } }
  skill_state     jsonb NOT NULL DEFAULT '{}'::jsonb,
                  -- { "<skill>": { enabled: bool } }
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text                   -- userId from auth
);

CREATE TABLE agent_config_edits (
  id          bigserial PRIMARY KEY,
  agent_name  text NOT NULL,
  user_id     text,
  field       text NOT NULL,             -- 'systemPrompt' | 'model' | 'capability.<name>.enabled' | ...
  before      jsonb,
  after       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_config_edits_agent_idx ON agent_config_edits(agent_name, created_at DESC);
```

`capability_state.toolEnabled` is keyed by the **namespaced** tool name (`<pack>.<tool>`) so it survives pack renames at the registry level. `mcp_state.toolEnabled` is keyed by the MCP server's tool name as the server advertises it.

The `system_prompt`, `model`, `sampling`, `budget`, `permissions` columns are nullable — null means "no overlay; use YAML". The three `*_state` columns are non-null objects so we can read partial state without a coalesce dance.

#### Merge precedence at boot

`defineFromConfig` (in `packages/registry/src/load-config.ts`) grows an optional `overlay` parameter:

```ts
interface DefineFromConfigOpts {
  configPath: string;
  entryRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** When set, merge any row in agent_config_overlay matching the agent name. */
  overlay?: { pool: Pool };
}
```

When `overlay.pool` is supplied, after building the YAML-derived `AgentDefinition` and before final `defineAgent()` validation, the loader reads the overlay row (if any) and applies, in order:

1. **System prompt / model / sampling / budget / permissions** — overlay wins field-by-field; YAML provides the seed for everything overlay leaves null.
2. **Capability gating** — for each capability pack the loader was about to merge contributions from, check `capability_state[pack].enabled`. If `false`, skip the entire pack (its tools, MCP servers, skills do not enter the agent definition). Default if absent: enabled.
3. **Tool gating** — after pack contributions are merged in, walk the resulting `localTools[]` and remove any whose namespaced name is `capability_state[pack].toolEnabled[name] === false`. Then merge any **disabled** tools into the agent's `permissions.deniedTools` (so they're also denied if a future builtin tries to reference them).
4. **MCP server / per-tool gating** — for each MCP server config, check `mcp_state[server].enabled`. If `false`, drop the server entirely. For enabled servers, record `mcp_state[server].toolEnabled` as a *runtime filter*; the existing `McpServerConfig.allowTools` field becomes the implementation vehicle (intersect declared allowTools with overlay-enabled).
5. **Skill gating** — for `skills.kind === "explicit"`, drop entries with `skill_state[name].enabled === false`. For `skills.kind === "directory"`, gating is applied at skill-load time inside core (see §3.4).

The result is fed to `defineAgent()` exactly like today, so all existing invariant checks (e.g. `requireApproval ∩ deniedTools = ∅`) still fire — and surface as 422 from the admin write endpoints, not at next boot.

### Hot-reload mechanics

#### Worker

`startWorker` already accepts `agent: AgentDefinition | ((job) => AgentDefinition | Promise<AgentDefinition>)`. When the entry boots, instead of passing a captured `AgentDefinition`, the entrypoint passes a resolver closure backed by a small cache:

```ts
// in the user's main.ts (new helper exported from @render-harness/registry)
const live = createLiveAgent({ configPath, pool });
await startWorker({ agent: (job) => live.get(job.agentName), ... });
```

`createLiveAgent` lives in a new module `packages/registry/src/live-agent.ts`. It:

1. Calls `defineFromConfig({ ..., overlay: { pool } })` once on boot and caches the result.
2. Opens a dedicated PG `LISTEN agent_config_changed` client (same pattern as `state/repo.ts`).
3. On each NOTIFY payload (`agent_name`), invalidates that agent's cache entry.
4. On next `get(name)`, re-runs `defineFromConfig` and caches the new definition.

Multi-instance fleets each subscribe to the channel; every instance refreshes independently. Worst case during the propagation window: one job runs on stale config — acceptable for a config edit.

#### Web

The web service holds an `agents: Record<string, AgentDefinition>` in closure today. We replace that with a `getAgent(name): AgentDefinition` + `listAgents(): AgentDefinition[]` pair backed by the same `LiveAgentRegistry`. The route handlers (`agents.ts`, `runs.ts`, `conversations.ts`) take the getter instead of the dict. `enqueueRun` continues to enqueue against pg-boss with just the agent name; the worker resolves freshly per job.

#### Admin route → pg_notify

Every admin PATCH writes the overlay row, then within the same transaction calls `pg_notify('agent_config_changed', $1)` with the agent name. The response is returned to the UI *after* the NOTIFY commits, so a subsequent `GET /admin/agents/:name` from the same client reflects the change. The UI is *not* required to refetch; we can ship the post-write response as the fresh summary.

### API surface

All routes are namespaced under `/admin/` and require the existing cookie-session auth. Returns `403` if `requireAdmin` is enabled and the resolver doesn't mark the session admin (v1 default: every authenticated session is admin, gating is structural).

| Route | Purpose |
|---|---|
| `GET /admin/agents/:name` | Full editable view: system prompt, model, sampling, budget, permissions, list of capability packs with per-pack `enabled` + per-tool `enabled`, list of MCP servers with per-server `enabled` + per-tool `enabled`, list of skills with `enabled`. Includes a `yaml` block (the original parsed config) and an `overlay` block (what's been changed). |
| `PATCH /admin/agents/:name` | Partial update. Body is a discriminated patch — `{ kind: "systemPrompt", value }`, `{ kind: "model", value }`, `{ kind: "sampling", value }`, `{ kind: "budget", value }`, `{ kind: "permissions", value }`, `{ kind: "capability", pack, enabled }`, `{ kind: "capabilityTool", pack, tool, enabled }`, `{ kind: "mcp", server, enabled }`, `{ kind: "mcpTool", server, tool, enabled }`, `{ kind: "skill", name, enabled }`. Validated against `HarnessConfigSchema`'s field-level zod sub-schemas (re-exported) before write. Returns the new full view on success. |
| `DELETE /admin/agents/:name/overlay` | Drop the whole overlay row (revert to pure YAML). Audit entry: `field='*'`. |
| `DELETE /admin/agents/:name/overlay/:field` | Revert a single field (`field=systemPrompt`, `field=model`, etc.). |
| `GET /admin/agents/:name/edits` | Audit-trail listing from `agent_config_edits`. Keyset paginated. |
| `GET /admin/agents/:name/tools` | Computed view: every tool the agent *currently exposes*, with `source` (builtin / capability / mcp), `namespacedName`, `enabled`. The source of truth for the UI's tool-toggle list. |
| `GET /admin/agents/:name/skills` | Computed view: every skill the agent currently surfaces, with metadata. |
| `GET /admin/schedules` | List `agent_schedules` rows (depends on recurring-tasks-plan). |
| `POST /admin/schedules` | Create — same shape as the `schedule_run` builtin but from the UI. |
| `PATCH /admin/schedules/:id` | Edit cron / input / notifications / enabled. |
| `DELETE /admin/schedules/:id` | Soft-cancel; `?hard=true` deletes. |
| `GET /admin/runtimes/:name` | Read-only view of the YAML `runtimes[]` block, including any `cron.schedule`. Marked `editable: false` with a `reason: "schedule lives in render.yaml; edit requires redeploy"`. |

Endpoints live in a new `packages/web/src/routes/admin.ts`. The schedule endpoints proxy through the recurring-tasks-plan's read-only `/schedules` if it lands first; otherwise this plan adds them directly and recurring-tasks-plan's web routes are a no-op.

### UI components

The existing `AgentsTab` becomes the read-only "agent overview" card and a new edit affordance opens a dedicated `AgentDetail` view (using the same hash routing pattern as `RunDetail`). New top-level tab "ADMIN" goes between `AGENTS` and `USAGE` for the per-agent edit forms and the schedule list — keeping `AGENTS` as the at-a-glance dashboard for non-admin viewers.

New files in `packages/ui/web/src/tabs/admin/`:

- `AdminTab.tsx` — top-level. Renders a list of agents on the left, the active agent's edit panes on the right.
- `SystemPromptEditor.tsx` — large `<textarea>` with auto-resize. Save button is disabled until dirty. "Revert to YAML" link when overlay has a value. Shows char count vs the schema's 50_000 cap.
- `ModelPicker.tsx` — provider + model select. Same options the CLI scaffolder offers, sourced from a shared list (see §4).
- `CapabilityList.tsx` — per-pack toggle row with an expand caret revealing per-tool toggles. Disabled-pack rows are dimmed and their per-tool toggles hidden.
- `McpServerList.tsx` — per-server toggle. Each server expands to a per-tool list driven by `GET /admin/agents/:name/tools` filtered to `source === "mcp"` for that server. Tools the server advertises but the agent has never seen are surfaced as "newly available" — same toggle UX.
- `SkillList.tsx` — per-skill toggle with metadata popover.
- `PermissionsEditor.tsx` — three text-area-as-list editors for allowedTools / deniedTools / requireApproval. Pre-fills with current values; merges into the overlay's `permissions` field.
- `BudgetSamplingEditor.tsx` — narrow form with numeric inputs. Save patches `budget` + `sampling`.
- `SchedulesPane.tsx` — table of `agent_schedules` rows. Inline cron editor with a "next 3 fires preview" (computed client-side via a tiny cron-parser).
- `RuntimeReadout.tsx` — read-only YAML runtimes display. Each cron runtime shows the schedule with a "redeploy required to change" badge.

Shared:
- `admin/api.ts` — fetchers for the `/admin/*` endpoints. Mirrors `web/src/api.ts` style.
- `admin/diff.ts` — helpers to highlight "this value differs from YAML" inline.

### Skills hot-reload

The skill toggle has a wrinkle: agents with `skills.kind === "directory"` load skill metadata from disk on every run-prep, not at boot. To honor `skill_state` for directory-based skills we extend the directory scanner in `packages/core/src/skills/` (where it lives today) to accept a filter:

```ts
loadSkillsFromDirectory(path, { enabledFilter?: (skillName: string) => boolean })
```

The live-agent registry passes a filter closure that reads the current overlay's `skill_state`. Loading happens per-run, so toggle effects are immediate without invalidation work.

## File-by-file changes

### New files

**Schema + migrations**
- `packages/core/sql/0004_agent_config_overlay.sql` — the two new tables.

**Core / registry**
- `packages/registry/src/live-agent.ts` — `createLiveAgent({ configPath, pool })` returning `{ get(name), list(), close() }`. Owns the LISTEN client.
- `packages/registry/src/overlay-merge.ts` — pure function `applyOverlay(baseAgent, overlayRow, mergedConfig)` returning a new `AgentDefinition`. Heavily unit-tested.
- `packages/registry/src/overlay-repo.ts` — Postgres CRUD for `agent_config_overlay` and `agent_config_edits`. `readOverlay`, `writeOverlayPatch`, `dropOverlay`, `dropOverlayField`, `recordEdit`, `listEdits`. Each mutator issues `pg_notify('agent_config_changed', agent_name)` inside the same transaction.
- `packages/registry/src/overlay-schema.ts` — zod schemas for the PATCH discriminated union; field-level re-exports from `HarnessConfigSchema`.

**Web**
- `packages/web/src/routes/admin.ts` — `registerAdminRoutes(app, ctx)` with all `/admin/*` endpoints.
- `packages/web/src/routes/admin.integration.test.ts` — round-trip tests over a live pool: write prompt → re-fetch agent → assert merged value.
- `packages/web/src/admin-context.ts` — small struct grouping `{ pool, live, queue, logger }` passed into the admin routes.

**UI**
- `packages/ui/web/src/tabs/admin/AdminTab.tsx`
- `packages/ui/web/src/tabs/admin/SystemPromptEditor.tsx`
- `packages/ui/web/src/tabs/admin/ModelPicker.tsx`
- `packages/ui/web/src/tabs/admin/CapabilityList.tsx`
- `packages/ui/web/src/tabs/admin/McpServerList.tsx`
- `packages/ui/web/src/tabs/admin/SkillList.tsx`
- `packages/ui/web/src/tabs/admin/PermissionsEditor.tsx`
- `packages/ui/web/src/tabs/admin/BudgetSamplingEditor.tsx`
- `packages/ui/web/src/tabs/admin/SchedulesPane.tsx`
- `packages/ui/web/src/tabs/admin/RuntimeReadout.tsx`
- `packages/ui/web/src/tabs/admin/api.ts`
- `packages/ui/web/src/tabs/admin/diff.ts`
- `packages/ui/web/src/tabs/admin/index.ts` — barrel.

**Contracts**
- `packages/contracts/src/admin.ts` — wire types: `AdminAgentView`, `AdminPatch` (discriminated union), `AdminTool`, `AdminSkill`, `AdminEdit`. Re-exported from `packages/contracts/src/index.ts`.

### Modified files

- `packages/registry/src/load-config.ts` — accept `overlay` opt; thread through to the merger. Touch a single ~10-line block.
- `packages/registry/src/index.ts` — re-export `createLiveAgent`, the overlay repo functions, and the new contract types.
- `packages/web/src/index.ts` — replace the `agents: Record<string, AgentDefinition>` closure with the `LiveAgentRegistry` getter. New `live` option on `ServeWebOpts` (or auto-built from `configPath` if a path is supplied). Wire `registerAdminRoutes`.
- `packages/web/src/routes/agents.ts` — call `live.list()` / `live.get(name)`.
- `packages/web/src/routes/runs.ts`, `routes/conversations.ts` — use the getter for any access to the agent definition.
- `packages/web/src/summary.ts` — `summariseAgent` gains an optional `overlay` arg so the AGENTS-tab readout shows "*(overridden)*" markers.
- `packages/runtime-worker/src/index.ts` — no API change. Examples/operator-demo will be updated to use `live.get` instead of capturing the agent.
- `packages/core/src/skills/loader.ts` (or current path) — accept `enabledFilter`.
- `packages/ui/web/src/App.tsx` — add ADMIN tab + route segment.
- `packages/ui/web/src/api.ts` — re-export admin fetchers (or leave in `admin/api.ts`).
- `examples/operator-demo/src/web.ts` and `worker.ts` — switch from the closed-over agent to a `LiveAgentRegistry` built from `render-harness.yaml`. This is the smallest change that makes the example exercise hot-reload end-to-end.
- `CLAUDE.md` — add a paragraph in "Conventions worth knowing" pointing at `docs/admin-ui-plan.md` for the overlay model. State that YAML remains the seed of truth on first boot; overlay edits are runtime state.

### Files explicitly **not** changed

- `packages/core/src/runAgent.ts` and the model adapter — no change. The agent definition the loop receives is already the post-merge shape.
- `packages/registry/src/schema.ts` — the YAML schema is unchanged; we only add a parallel runtime overlay.
- `templates/render-harness-entry/` — no template changes. New projects don't need to opt into the overlay; `defineFromConfig` works exactly as today without the `overlay` arg.
- All existing capabilities packs — toggling is implemented at the merger, not in the pack.

## Reused existing primitives

- `WorkerOpts.agent` accepting a resolver function — `packages/runtime-worker/src/index.ts:62`. This is the lever that makes worker-side hot-reload free.
- `defineFromConfig` and `mergePackContributions` — `packages/registry/src/load-config.ts`. The overlay merger slots in *after* pack contributions are merged.
- `pg_notify` + `LISTEN` — already used by streaming (`agent_runs` channel) and the conversations work; the new `agent_config_changed` channel follows the same pattern.
- The cookie-session auth flow — `packages/ui/src/auth.ts` + `wrapWithUiSessionIfAvailable` in `packages/web/src/ui-mount.ts`. No new auth machinery.
- `summariseAgent` — `packages/web/src/summary.ts`. Lightly extended to include the overlay diff for the AGENTS tab "*(overridden)*" badges.
- Skill directory scanner — accepts a new filter callback rather than a new code path.
- `HarnessConfigSchema`'s field-level zod sub-schemas (`ModelSpecSchema`, `SamplingParamsSchema`, `BudgetSchema`, `PermissionsSchema`) — re-exported and reused as PATCH-body validators so YAML and overlay validation cannot drift.
- `agent_schedules` table + `schedule_*` builtins from `docs/recurring-tasks-plan.md`. Admin schedule routes are a thin CRUD facade over the same repo functions.

## Out of scope for v1

Each deferral is intentional. Listed so the gap is explicit:

1. **"Promote overlay → YAML" export.** v1 leaves the overlay in Postgres. When users want to "graduate" a deployment's overlay into their committed `render-harness.yaml`, they hand-merge for now. A `GET /admin/agents/:name/yaml` endpoint that emits the merged YAML body is a natural follow-up but adds complexity (round-trip of comments / order preservation) we don't need yet.
2. **MCP server discovery.** Adding *new* MCP servers from the UI (rather than toggling existing ones) requires schema-level YAML editing and is deferred. Same for adding new capability packs.
3. **Multi-admin roles.** Today, one API key = one admin. Per-user RBAC (read-only operator, full admin, etc.) is out.
4. **Edit conflict detection.** Two admins simultaneously editing the prompt last-writer-wins. Acceptable v1 behavior; revisit if a customer complains.
5. **Live model swap mid-conversation.** Switching the model takes effect on the next run in the conversation. The plan does not add a "re-run with new model" affordance; users start a new conversation if they want a clean break.
6. **Cron-runtime schedule live edit.** Editing the YAML `runtimes[].schedule` from the UI needs a redeploy to take effect, since the Render Cron service has the cron expression baked in. v1 surfaces it read-only; ad-hoc scheduling via `agent_schedules` is the live path.
7. **Audit UI.** `agent_config_edits` is written but only queryable via psql or `GET /admin/agents/:name/edits`; no dedicated UI tab in v1.
8. **Skill content editing.** Skills can be toggled but not rewritten from the UI. Content lives on disk / in capability packs.
9. **Per-tool tracing in admin.** The "what did this toggle break?" diagnostic loop is left to the existing RUNS tab.
10. **Tool toggling by builtins.** Builtins (`load_skill`, `fetch_url`, etc.) are gated through `permissions.deniedTools` already; the admin UI exposes those via the PermissionsEditor rather than a separate builtin-toggle widget. Deduplication intentional.

## Verification

### Unit — pure logic
- `packages/registry/src/overlay-merge.test.ts` — for each PATCH kind, assert the merged `AgentDefinition` reflects the overlay; assert null/absent overlay keeps YAML untouched; assert capability disable removes namespaced tools; assert MCP per-tool disable narrows `allowTools`.
- `packages/registry/src/overlay-schema.test.ts` — every PATCH discriminant accepts valid bodies and rejects invalid ones.
- `packages/web/src/summary.test.ts` — overlay markers appear when expected.

### Integration — needs `pnpm db:up`
- `packages/web/src/routes/admin.integration.test.ts`:
  1. PATCH systemPrompt → re-fetch agent summary → new prompt + `length` updated.
  2. PATCH capability disable → `GET /admin/agents/:name/tools` no longer lists that pack's tools.
  3. PATCH MCP per-tool disable → tool removed from agent definition; `agent_messages` for a follow-up run doesn't include it in the tool list (smoke check via `runs` route, optional v1).
  4. PATCH then DELETE overlay field → reverts to YAML value.
  5. NOTIFY propagation: open two `LiveAgentRegistry` instances against the same pool; PATCH via one, observe `get()` returning fresh definition on the other within ~50ms.
  6. Concurrent admins: two PATCHes interleaved — last-writer-wins; both edits show in `agent_config_edits`.
- `packages/registry/src/live-agent.test.ts` — cache invalidation on NOTIFY, plus close()-on-shutdown.

### Manual UX
1. `pnpm db:up && pnpm build && pnpm dev:operator-web` + `pnpm dev:operator-worker`.
2. Sign in to `/ui/login`. Navigate to the new ADMIN tab.
3. Edit the system prompt; save; start a chat in the CHAT tab — assistant responses reflect the new prompt without restarting either process.
4. Disable a capability pack; confirm its tools vanish from the next run's tool list (visible in the RUNS tab's tool calls panel).
5. Disable an individual MCP tool; confirm the model no longer surfaces it.
6. Create an ad-hoc schedule from the SchedulesPane (requires recurring-tasks-plan landed). Wait for fire; confirm a run appears tagged `metadata.scheduleId`.
7. Restart only the web process. Refresh `/ui` — overlay changes persist. Restart only the worker — the next job's prompt is still the overlay value.
8. Drop the overlay; confirm the original YAML system prompt reappears.

### Lint / type / test gates
- `pnpm check`
- `pnpm typecheck`
- `pnpm test`

## Execution order

Each step is a self-contained commit/PR. Numbered to minimize risk and let the work land in pieces.

1. **Migration + repo.** Add `0004_agent_config_overlay.sql`, `overlay-repo.ts`, `overlay-schema.ts`. Tests pass against an empty overlay table. No live wiring yet.
2. **Overlay merger.** Implement `overlay-merge.ts` and refactor `defineFromConfig` to call it when an `overlay` opt is provided. Unit tests for every PATCH kind. No web/UI changes.
3. **LiveAgentRegistry.** Implement `live-agent.ts` with LISTEN/NOTIFY-driven cache invalidation. Tests against the local stack.
4. **Web getter conversion.** Swap `agents: Record<...>` for `live.get/list` in `serveWeb` and the existing routes. Pure refactor — no behavior change yet, but unblocks admin routes.
5. **Admin routes — read-only.** Implement `GET /admin/agents/:name`, `GET /admin/agents/:name/tools`, `GET /admin/agents/:name/skills`, `GET /admin/agents/:name/edits`. Integration tests.
6. **Admin routes — write.** `PATCH`, `DELETE` endpoints + audit-row writes + NOTIFY. Integration tests cover end-to-end propagation.
7. **UI scaffolding.** New ADMIN tab + `AdminTab` + a single editor (`SystemPromptEditor`). Manual smoke.
8. **UI — capability/MCP/skill toggles.** Add the remaining four editor components.
9. **UI — permissions, budget, sampling.** Adds the lower-frequency editors.
10. **Runtimes readout + schedules pane.** Read-only runtime view first; schedule CRUD lands once `recurring-tasks-plan` is in. If it isn't yet, ship 1–9 and revisit the schedules pane behind a feature flag.
11. **`operator-demo` migration.** Update both `web.ts` and `worker.ts` to consume `live.get`. Acts as the canary for entry authors.
12. **Docs.** Append the overlay-model paragraph to `CLAUDE.md` and add a "Admin overlay" section to `docs/registry-guide.md`.

Steps 1–6 are backend-only and shippable behind no UI; steps 7–10 are progressive enhancement of the SPA. Steps 11–12 are docs and example housekeeping.
