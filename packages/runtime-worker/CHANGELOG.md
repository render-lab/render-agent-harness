# @render-harness/runtime-worker

## 0.6.0

### Minor Changes

- Coordinated 0.6.0 minor cut. Capability packs can now declare SQL migrations via a new `migrations` slot on the `CapabilityPack` contract; the harness applies them at boot before any agent code runs.

  **`@render-harness/core`** — new `MigrationFile` and `PackMigration` interface exports. `applyMigrations(pool, opts?)` gains an optional second argument: when `opts.packMigrations` is non-empty, pack-contributed migrations run after core migrations under the same advisory lock. Each pack migration runs in its own transaction; on success `(packName, id)` is recorded in a new `agent_pack_migrations` core table (added via new core migration `0005_pack_migrations.sql`), so subsequent boots skip already-applied entries cheaply. A failing pack migration aborts boot with an actionable error naming the pack + migration id, and rolls back its transaction so the DB isn't left half-migrated. `AgentDefinition` gains an optional `packMigrations?: PackMigration[]` field that `defineFromConfig` populates from loaded packs. The single-arg `applyMigrations(pool)` call site stays backward-compatible — existing code keeps working unchanged.

  **`@render-harness/contracts`** — no public-surface change; bumped to keep the family coordinated.

  **`@render-harness/registry`** — `CapabilityPack` contract gains an optional `migrations?: (ctx: PackContext) => MigrationFile[] | Promise<MigrationFile[]>` slot. The zod validator at `assertCapabilityPack` accepts the new field. `defineFromConfig` walks every loaded pack's `migrations` callback, prefixes each entry with `packName`, and surfaces the collected list on `AgentDefinition.packMigrations`. The runner dedupes by `(packName, id)`, so the same pack contributed across multiple agents in a bundle is applied once. `MigrationFile` and `PackMigration` are re-exported from `@render-harness/registry` for pack-author convenience.

  **`@render-harness/runtime-cron`, `runtime-web`, `runtime-worker`, `runtime-workflows`, `web`** — each runtime adapter now passes `{ packMigrations: agent.packMigrations ?? [] }` (or, for the multi-agent shapes, the merged flat list across all known agents) into `applyMigrations` at boot. The trigger-side `applyMigrations` call in `runtime-workflows/triggerAgentWorkflow` stays single-arg — it only needs core tables for the `ensureRun` insert that follows.

  **`create-render-agent`** — generated scaffold entries (`src/runtime/cron-entry.ts`, `worker-entry.ts`) call `applyMigrations(pool, { packMigrations: agent.packMigrations ?? [] })` instead of `applyMigrations(pool)`. New scaffolds inherit pack-migration support automatically; existing scaffolded deployments need to either re-scaffold or manually update the entry file.

  **Every published `@render-harness/cap-*` pack** — bumped to stay on the same 0.6 baseline. No behavioral change in the existing packs; the new `migrations` slot is opt-in.

  **Operators upgrading existing deployments** need to:
  1. Bump `harnessVersion` in `render-harness.yaml` to `"^0.6.0"`.
  2. Bump every `"@render-harness/*"` dep range in `package.json` to `"^0.6.0"`.
  3. If the deployment uses an old scaffolded entry, update the `applyMigrations(pool)` call to `applyMigrations(pool, { packMigrations: agent.packMigrations ?? [] })`. Without this, packs using `migrations` will silently have nothing applied.

  See `docs-site/src/content/docs/authoring-capability-packs.mdx#migrations` for the pack-author walkthrough and the [`docs/capabilities-shipping-plan.md`](docs/capabilities-shipping-plan.md) Phase 1.5 entry for the design rationale.

### Patch Changes

- Updated dependencies
  - @render-harness/core@0.6.0

## 0.5.0

### Minor Changes

- 2c465b3: Per-end-user OAuth connection API + `cap-google` (Gmail + Calendar).

  This is a coordinated minor cut. Every first-party harness package crosses `0.4 → 0.5` together because the platform additions touch every layer:

  **`@render-harness/core`** — new `OAuthProviderConfig`, encrypted token storage (`agent_user_connections`), per-run `SecretsContext` built from the run's `userId`, refresh-on-use with provider-rotation handling, `NeedsConnectionError`, and a process-level OAuth provider registry. New SQL migration `0004_connections.sql`. `LocalToolHandler.handler` args gain optional `userId` and `secrets: SecretsContext` (additive — existing packs keep compiling).

  **`@render-harness/contracts`** — `UserConnectionSummary`, `ConnectionProviderSummary`, `ConnectionsResp`, `StartConnectionResp`, `DeleteConnectionResp`.

  **`@render-harness/registry`** — `CapabilityPack.oauthProviders` and `connectionsRequired` fields; `defineFromConfig` auto-registers providers from loaded packs.

  **`@render-harness/web`** — `/connections/:provider/start|callback`, `GET /connections`, `DELETE /connections/:provider` routes; Diagnostics surfaces `CONNECTIONS_ENCRYPTION_KEY` and per-provider OAuth client credential checks.

  **`@render-harness/ui`** — new Connections tab in the operator UI; `listConnections` / `startConnection` / `deleteConnection` API helpers.

  **`@render-harness/cap-google`** (new) — Gmail (`gmail.search`, `gmail.get_message`, `gmail.send`, `gmail.modify_labels`) + Calendar (`calendar.list_events`, `calendar.get_event`, `calendar.freebusy`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event`) tools backed by the connection API. Adds Google as the first registered OAuth provider with `access_type=offline` + `prompt=consent` so refresh tokens are returned. Read-only mode (`accessMode: "read"`) drops the write tools and narrows scopes.

  Operators upgrading existing deployments need to:
  1. Set `CONNECTIONS_ENCRYPTION_KEY` (32 random bytes, base64) on the harness service.
  2. For each provider, register an OAuth 2.0 client and set its client id/secret env vars.
  3. Update `harnessVersion` in `render-harness.yaml` and `@render-harness/*` dep ranges in `package.json` to `^0.5.0`.

  See `docs/connections-api.md` for the full design and `docs-site/src/content/docs/connections-api.mdx` for the user-facing guide.

### Patch Changes

- Updated dependencies [2c465b3]
  - @render-harness/core@0.5.0

## 0.4.1

### Patch Changes

- Make `permissions.requireApproval` actually resumable end-to-end. Previously, runs paused by `requireApproval` got stuck in `awaiting_approval` forever: the operator UI's only resume affordance was `POST /runs/:id/input`, which appended the operator's text as a `role: "user"` message and re-enqueued the run **without** the `approvedToolCallIds` core expects. The worker then re-ran `runAgent` with no approved set, hit the same `requireApproval` gate, and paused on the same `tool_use_id` again — silently and indefinitely (and worse, the dangling user text wedged between an unanswered `tool_use` and nothing else could 400 the next model call).

  This patch wires the flow end-to-end:
  - **`@render-harness/core`** — `pauseForApproval` now writes `{ pauseReason: "awaiting_approval", awaitingApproval: { tool_use_id, name, input } }` into `agent_runs.metadata`, mirroring how `pauseForAwaitingInput` persists `ask_user` state. Lets every downstream consumer (web, UI, integration tests) read pause shape from the run row without walking the message log. Also re-exports `mergeRunMetadata` for callers that need to seed pause metadata in tests.
  - **`@render-harness/contracts`** — `RunSummary` gains a typed `pause: RunPauseInfo | null` field (discriminated by `reason: "awaiting_input" | "awaiting_approval"`). Adds `SendInputReq` documenting both wire shapes for `POST /runs/:id/input`.
  - **`@render-harness/web`** — `POST /runs/:id/input` now branches on the run's current pause reason: `awaiting_input` accepts `{ input: string }` exactly as before; `awaiting_approval` accepts `{ approvedToolCallIds: string[] }` and stuffs the approved ids into the re-enqueued `RunJob` payload. Cross-shape requests return `400 invalid_input` with a message naming the expected shape; a stale `tool_use_id` returns `409 stale_tool_use_id` with the pending id for the UI to retry against. `GET /runs/:id` now correctly runs the run row through `serializeRun` (it was returning the raw `AgentRun`, which is why no field added to `RunSummary` ever surfaced over the wire previously).
  - **`@render-harness/runtime-worker`** — `RunJob` gains an optional `approvedToolCallIds: string[]` field; `processJob` threads it into `runAgent({ approvedToolCallIds: new Set(...) })`, exactly mirroring how `@render-harness/runtime-workflows` already did it. Without this, every web-side approval was a no-op even after the route accepted it.
  - **`@render-harness/ui`** — `useConversationSession` fetches the run's pause shape whenever status flips to `paused` and exposes `pause`, `approveToolCall(toolUseId)`, and `approveBusy` from the hook. `ChatTab`'s `ToolCallBlock` consults the new `ChatSessionContext`; when a tool_use is the one blocking the run, the block highlights with a warn border and renders an inline **Approve and resume** button. `RunDetail`'s `ActionsCard` replaces the generic "send hitl input" textarea with branched UI: `awaiting_approval` renders the proposed tool + an Approve button; `awaiting_input` renders the original question, optional choice list, and a labelled reply form. Rejecting an approval still goes through `Cancel run`.

  End-to-end coverage in `packages/web/src/routes/runs.integration.test.ts`:
  - `awaiting_input` accepts `{ input }`, rejects `{ approvedToolCallIds }`.
  - `awaiting_approval` accepts `{ approvedToolCallIds }`, rejects `{ input }`, rejects stale tool_use_id, and the re-enqueued job carries the approved ids through verbatim.
  - `GET /runs/:id` surfaces `run.pause.reason` + `run.pause.payload.tool_use_id` derived from metadata.

  No new public exports beyond the additive `RunPauseInfo` type + `approveToolCalls` client + `approveToolCall` session method + `RunJob.approvedToolCallIds`, so this stays inside a coordinated patch cut with no family-wide minor bump.

- Updated dependencies
  - @render-harness/core@0.4.1

## 0.4.0

### Minor Changes

- cap-slack: stop surfacing raw Slack user and channel IDs to agents.
  - `slack.get_thread` and `slack.get_channel_history` now auto-resolve user IDs and the queried channel ID, attach `user_display_name` per message, rewrite `<@U…>` and `<#C…|name>` references in `text_resolved`, and return `resolved_users` / `resolved_channel` maps in the response.
  - Adds two new read tools: `slack.get_user_info` and `slack.get_channel_info` for on-demand lookups (for example to label IDs the agent sees in attachments, payload metadata, or operator-provided text).
  - Lookups share an in-memory cache scoped to the agent process so repeated calls stay cheap across turns.

  The new tools trigger a coordinated family-wide minor bump per AGENTS.md "Minor bumps must be coordinated across the whole family". The other listed packages are packaging-only bumps with no behavioral change.

  `@render-harness/web` also drops its `@render-harness/ui` peerDependency in this cut. Web has never imported the UI statically — it dynamic-imports `@render-harness/ui` inside `wrapWithUiSessionIfAvailable` / `mountUiIfAvailable` with a guarded fallback. The peer declaration was advisory only, and it was the sole reason Changesets cascaded `web` to a MAJOR bump during every coordinated minor cut (see commit `420c904`'s manual workaround). Consumers that want the operator UI install `@render-harness/ui` explicitly alongside `@render-harness/web` exactly as before; the scaffolder already adds it as a regular dependency when `ui` is selected, so no scaffold changes are required.

### Patch Changes

- Updated dependencies
  - @render-harness/core@0.4.0

    0.3.0##

### Minor Changes

- Coordinated 0.3.0 baseline cut across the entire first-party harness family.
  See AGENTS.md § "Minor bumps must be coordinated across the whole family".

## 0.2.2

### Patch Changes

- @render-harness/core@0.2.2

## 0.2.1

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/core@0.2.1

## 0.2.0

### Minor Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/core@0.2.0
