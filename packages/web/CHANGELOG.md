# @render-harness/web

## 0.6.1

### Patch Changes

- ab4dbd1: **NEW OPT-IN: `refreshTokenOptional` on `OAuthProviderConfig`.**

  Default behavior is unchanged — existing providers (Google, Microsoft, Slack, etc.) still throw when the token endpoint omits a `refresh_token`, which is the right move because the omission is almost always a misconfigured scope.

  Set `refreshTokenOptional: true` for providers that issue long-lived access tokens with no refresh token by design — Notion's default public-integration flow is the canonical case (the [Notion docs](https://developers.notion.com/docs/authorization) explicitly call out no refresh tokens on standard public OAuth). Stripe Connect's standard-account flow and a handful of legacy SaaS APIs have the same shape.

  When the flag is set:
  - `exchangeAuthorizationCode` no longer rejects the (refreshless) token response.
  - The web callback route stores an empty-string sentinel in the `refreshToken` column and anchors `expires_at` 100 years in the future when the provider doesn't return `expires_in`.
  - `SecretsContext.requireConnection` refresh-on-use becomes a no-op for that provider — the stored access token is returned unchanged. Pack tools handle the eventual 401 (token revoked by the user, etc.) themselves with a clear "ask the user to reconnect at /ui/connections" message.

  This unblocks `@render-harness/cap-notion` (shipping at `0.6.0` in this release) and any future packs for refresh-token-less providers. Existing OAuth packs (cap-google) are unaffected — the flag is opt-in.

- Updated dependencies [ab4dbd1]
  - @render-harness/core@0.6.1
  - @render-harness/registry@0.6.1
  - @render-harness/runtime-worker@0.6.1

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
  - @render-harness/contracts@0.6.0
  - @render-harness/core@0.6.0
  - @render-harness/registry@0.6.0
  - @render-harness/runtime-worker@0.6.0

## 0.5.3

### Patch Changes

- Auto-configure the operator UI's Install capability flow so installing a pack into an existing harness "just works".

  **Every official pack is installable through the modal.** `OFFICIAL_CAPABILITY_INSTALLS` in the wizard previously only covered 4 packs (`cap-slack`, `cap-github`, `cap-linear`, `cap-webhook-generic`); picking any of the 7 others (`cap-search-exa`, `cap-search-tavily`, `cap-scrape-firecrawl`, `cap-google`, `cap-memory-pg`, `cap-filesystem`, `cap-browser-browserbase`) was impossible from the UI and would 400 with `unknown_capability` even if the request were hand-crafted. The map now covers all 11 published packs, each with `label`, `description`, read/write tool names, env vars, connector flag, and an optional caveat surfaced inline in the modal.

  **New `/api/capabilities/catalog` endpoint** on the wizard serializes the map; the deployed harness exposes a same-origin `/capabilities/catalog` proxy mirroring the existing `/agents/catalog` proxy (60s in-process cache, 401 unauth, 503 when the wizard URL is unset). The Install capability modal now fetches this catalog on mount instead of carrying a hardcoded 4-pack list, so the modal stays in sync with whatever the wizard knows without a UI redeploy. Pack-specific config inputs (e.g. Slack's allowed channels) and the access-mode toggle are gated on whether the selected pack has write tools, and a pack-specific description + caveat panel renders alongside the selector.

  **Tier A builtins now ride along when the wizard expands `allowedTools`.** Previously, installing any capability into an agent whose template ships a restrictive `shared.permissions.allowedTools` (the support-bot gallery template does) silently stripped `load_skill`, `fetch_full_result`, `fetch_url`, `current_time`, `ask_user`, and `todo` from the model's tool catalog — those are "always on" by core's design, but a strict allowlist filters them out at request time anyway. The mutator now ensures every Tier A name lands in the allowlist alongside the pack's tools. Critically, the mutator no longer introduces an `allowedTools` allowlist when the agent didn't already have one (the previous behaviour silently turned every open agent into "only these N tools allowed" on the first install).

  **`POST /api/agents/add` also expands `allowedTools` for any capability the bundle pulls in.** Adding research-cron to a restrictive agent no longer leaves the new cron unable to call its Exa search tools. The expansion is read-only by default (operators can upgrade to read+write via the Install capability modal); a warning per added pack surfaces in the route response so the operator UI can show what shifted.

  The user-facing chain: pick "Exa web search" in the Install capability modal -> the wizard commits `cap-search-exa` to `capabilities[]`, grows `allowedTools` with the Exa MCP tool names plus the Tier A builtins, and Render auto-deploys. The model immediately sees `web_search_exa` / `web_fetch_exa` / `web_search_advanced_exa` in its toolset alongside `load_skill` and friends.

## 0.5.2

### Patch Changes

- web: mount `/connections` routes even when no capability pack registers an OAuth provider.

  `mountConnectionsRoutes` previously short-circuited when `listRegisteredOAuthProviders()` returned an empty list — directly contradicting its own doc comment, which promised the routes would mount in the "not yet configured" state so the UI could render an empty Connections tab. With the routes unmounted, `GET /connections` fell through to the SPA catch-all and returned HTML, which `request<T>()` correctly refused to type as JSON and surfaced as `"server returned non-JSON for /connections; the deployed web service may be missing this route — upgrade @render-harness/web"`. Operators saw a misleading "upgrade needed" hint on a harness that was already on the latest version.

  The routes now mount unconditionally (unless `serveWeb({ connections: false })`). `GET /connections` returns `{ providers: [], connections: [] }` for harnesses that haven't installed any OAuth pack — the Connections tab renders an empty state, no error. New regression test in `connections.integration.test.ts` pins the empty-registry behavior so the short-circuit doesn't sneak back in.

  No agent code changes required — the new behavior applies automatically on redeploy. The "not yet configured" hint UX (e.g. when `CONNECTIONS_ENCRYPTION_KEY` is unset for a harness that _does_ have an OAuth pack) is unchanged: the per-handler 503 path still fires there.

## 0.5.1

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.5.1

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
  - @render-harness/contracts@0.5.0
  - @render-harness/registry@0.5.0
  - @render-harness/runtime-worker@0.5.0

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
  - @render-harness/contracts@0.4.1
  - @render-harness/runtime-worker@0.4.1
  - @render-harness/registry@0.4.1

## 0.4.0

### Minor Changes

- Realign onto the 0.4.x family line. Coordinated minor cut accidentally cascade-patched `web` to `0.3.1` instead of carrying it onto the new minor, leaving the runtime harness version check red for every deployed harness (no single `harnessVersion` semver range satisfies both `web@0.3.1` and `core@0.4.0`). See AGENTS.md § "Realigning a drifted package" and the matching "Things that bit us recently" entry.

## 0.3.1

### Patch Changes

- Updated dependencies
  - @render-harness/core@0.4.0
  - @render-harness/contracts@0.4.0
  - @render-harness/registry@0.4.0
  - @render-harness/runtime-worker@0.4.0

## 0.3.0

### Minor Changes

- 70ab0f4: Zero-config Add agent in the deployed harness.
  - `@render-harness/web`: new `GET /agents/catalog` route proxies the wizard catalog same-origin so the browser never crosses origins (the wizard ships no CORS headers). Response is cached in-process for 60s. The proxy and the existing add/install/edit-model routes now default the wizard URL server-side; `RENDER_HARNESS_WIZARD_URL` becomes an opt-in override.
  - `@render-harness/wizard`: `listAddableAgents` now flattens every gallery entry, not just bundles. `planAgentAdd` accepts agents that reference a builtin (no `agent.entrypoint`) and produces a null `sourceFilePath` so the route skips the src/ probe and write. Single-agent gallery entries (chat, support-bot, research-cron, work-monitor) are addable from the operator UI.
  - `@render-harness/registry`: `enrichDeploymentInfo` defaults `wizardServiceUrl` to the public wizard. The Config tab's description of `RENDER_HARNESS_WIZARD_URL` is reworded to "override only" and `WIZARD_SHARED_SECRET`'s description is clarified. The gallery loader walks `src/` for every entry kind so single-agent entries that ship custom source are picked up too.
  - `@render-harness/ui`: Add agent panel is always visible on the Agents tab and shows a one-line hint when the deployment can't commit (missing repo locator / shared secret). The catalog modal swaps the flat `<select>` for a filterable card grid, surfaces actionable error codes (`needs_install`, `wizard_shared_secret_not_configured`, `repo_locator_missing`, `wizard_service_not_configured`), and reuses `useDeployWatch` + the toaster so successful adds show committed → restarting → restored with a Reload action.

### Patch Changes

- Updated dependencies [70ab0f4]
  - @render-harness/registry@0.2.4
  - @render-harness/ui@0.2.5

## 0.2.6

### Patch Changes

- toaster for changes pushed to render
- Updated dependencies
  - @render-harness/contracts@0.2.2
  - @render-harness/ui@0.2.4
  - @render-harness/core@0.2.2
  - @render-harness/registry@0.2.3
  - @render-harness/runtime-worker@0.2.2

## 0.2.5

### Patch Changes

- fixes
- Updated dependencies
  - @render-harness/ui@0.2.3

## 0.2.4

### Patch Changes

- c2cc5c6: `PUT /config/env-vars/:name` now explicitly POSTs to
  `/v1/services/:id/deploys` with `deployMode: "deploy_only"` after the
  env-var write succeeds. Render's env-var API endpoint only persists
  the value — it does not roll the service — so the previous flow
  saved the new value but the running container kept the old
  `process.env`. Symptoms: clicking "Save & restart" in the Config tab
  appeared to do nothing, and toggling Vitals (which writes
  `RENDER_HARNESS_VITALS_ENABLED`) never flipped the feature on
  because the freshly-saved env never made it into a restarted
  process. The response now reports `restart: "queued"` or
  `restart: "save_only"` (with a `deployError` payload) so the UI can
  surface when Render rejected the deploy trigger and the operator
  needs to redeploy manually.
- Updated dependencies [c2cc5c6]
  - @render-harness/ui@0.2.2

## 0.2.3

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.2.2

## 0.2.2

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/contracts@0.2.1
  - @render-harness/core@0.2.1
  - @render-harness/registry@0.2.1
  - @render-harness/runtime-worker@0.2.1
  - @render-harness/ui@0.2.1

## 0.2.1

### Patch Changes

- Updated dependencies
  - @render-harness/ui@0.1.5

## 0.2.0

### Minor Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/contracts@0.2.0
  - @render-harness/core@0.2.0
  - @render-harness/registry@0.2.0
  - @render-harness/runtime-worker@0.2.0
  - @render-harness/ui@0.1.4
