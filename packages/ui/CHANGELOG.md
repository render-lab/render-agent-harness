# @render-harness/ui

## 0.8.1

### Patch Changes

- Rebrand the operator UI to **Render Loops**.
  - Sidebar logo flips `Render / Harness` → `Render / Loops`.
  - Compact version badge changes from `Harness X.Y.Z` (and `Harness mixed` / `Harness unknown`) to `Loops X.Y.Z` (and `Loops mixed` / `Loops unknown`).
  - Browser tab title goes from `render-harness / operator` to `render-loops / operator` (same for the sign-in and build-missing pages served by `serveUi`).
  - Config tab section header `HARNESS VERSION` → `LOOPS VERSION`.
  - Docs tab iframe `title="Render Harness documentation"` → `title="Render Loops documentation"`.
  - Guide tab long-form sections (Tour, Capabilities, Agent runtime, Customizing, Deploy) and the Connections tab subtitle now read as Render Loops + loop (the deployable) instead of "the harness".
  - Modal error copy on Add agent / Edit model / Edit system prompt switched "this harness" → "this loop".

  Operator-facing copy only. No exported APIs, schemas, env vars, or routes change. Package name (`@render-harness/ui`), file paths (`render-harness.yaml`, `.render-harness/agent.json`), the `harnessVersion` schema field, and the deployed GitHub App name remain on the existing `render-harness` spellings.

## 0.8.0

### Minor Changes

- 03f9f11: Edit system prompts in the operator UI's Agents tab. New `PATCH /agents/:slug/system-prompt` route on `@render-harness/web` clones the managed repo via the same deploy-key path that powers the model edit, rewrites `agents[i].agent.systemPrompt` in `render-harness.yaml`, commits, and lets Render auto-deploy roll out the change. The Agents tab grows an "edit" affordance next to the system-prompt section for builtin (`kind: chat`) agents; custom (`kind: custom`) agents stay read-only and surface a "defined in `<entrypoint>` — edit in code and redeploy" hint instead, because their prompt lives in TypeScript source.

  Pieces:
  - **`@render-harness/core`** — new `AgentSource` type and optional `source` field on `AgentDefinition`. Populated by the registry; unset for hand-authored `defineAgent({...})` calls.
  - **`@render-harness/registry`** — new `mutateAgentSystemPrompt` mutator + `AgentNotEditableError` in `repo-mutations`. `defineChatAgent` stamps `source: { kind: "builtin" }`; `defineFromConfig` stamps `source: { kind: "custom", entrypoint }` on dynamic-imported agents. Multi-line prompts emit as `|` block scalars so the on-disk YAML stays readable; round-trip through `parseDocument` preserves comments and unrelated fields.
  - **`@render-harness/contracts`** — `AgentSummary` grows `source` and `systemPrompt` (full body). The full prompt is already accessible via `runAgent` at runtime; surfacing it on `GET /agents` lets the operator UI populate its edit modal without a second round-trip.
  - **`@render-harness/web`** — new route mounted in `serveWeb`. Deploy-key path is preferred; falls through to wizard-proxy for harnesses scaffolded before May 2026's GITHUB_DEPLOY_KEY migration. Returns 409 `agent_not_editable` (with `entrypoint` pointer) when the targeted agent is `kind: custom`.
  - **`@render-harness/ui`** — `EditSystemPromptModal` with a resizable textarea, char count, 50,000-char limit, and the same committed → restarting → restored toast chain the existing edit-model and install-capability flows use.
  - **`@render-harness/wizard`** — new `PATCH /api/agents/:slug/system-prompt` route. Sibling of `/api/agents/:slug/model`, same `WIZARD_SHARED_SECRET` auth + Octokit commit shape, same deprecation log warning operators to rotate to the deploy-key path.

  Per [AGENTS.md](https://github.com/render-lab/render-agent-harness/blob/main/AGENTS.md#minor-bumps-must-be-coordinated-across-the-whole-family) this is a coordinated minor cut: every published first-party harness package goes to the same `0.8.0` baseline so `harnessVersion: "^0.8.0"` in scaffolded `render-harness.yaml` files satisfies every dep. Existing managed harnesses need a manual bump of `harnessVersion` and their `@render-harness/*` dep ranges before the new route is reachable; the scaffolded `render-harness.yaml` is updated automatically by `bundle-gallery.ts`.

### Patch Changes

- 89c74d6: Two operator-UI bugs surfaced by the first real-world post-0.7.0 capability install:

  **1. Install map pinned every cap to a stale minor line.** `OFFICIAL_CAPABILITY_INSTALLS` in `@render-harness/registry/repo-mutations` carried hardcoded `versionRange: "^0.5.0"` (and `^0.1.1` for older entries) for every pack — installing cap-google from the operator UI on a 0.7.0 harness wrote `"@render-harness/cap-google": "^0.5.0"` into package.json, which pins the dep to the 0.5.x line and trips the runtime version check (mixed minors across the family). Bumped every literal to `^0.7.0`.

  Also added 5 missing entries the Wave 1 cuts shipped without: `cap-render`, `cap-notion`, `cap-intercom`, `cap-granola`, `cap-figma`. These packs were in the gallery but couldn't be installed from the operator UI.

  To prevent recurrence: new regression test in `packages/registry/src/repo-mutations/capability-install.versions.test.ts` walks `packages/capabilities/*/package.json` from the workspace, computes the expected `^<major.minor.0>` range, and fails if any catalog entry drifts (either wrong version OR missing entirely). Next coordinated minor cut will trip this test in CI and surface a clear fix message.

  **2. Install capability had no post-commit feedback.** `InstallCapabilityModal`'s `onInstalled` callback set a static notice and returned. After the commit landed on the managed repo, Render auto-deployed but the operator got no signal — nothing visible until they reloaded the page minutes later. Rewired the `AgentsTab` callback to also call `startRedeployWatch(message)`, the same committed → restarting → restored toast chain Add agent already uses. Operator now sees a Reload action once the new pack is live.

- Updated dependencies [03f9f11]
  - @render-harness/core@0.8.0
  - @render-harness/contracts@0.8.0

## 0.7.0

### Minor Changes

- 0a772da: Coordinated 0.7.0 minor cut: per-harness SSH deploy keys replace `WIZARD_SHARED_SECRET` for edit-in-UI commits.

  **What changed for harness operators**
  - New transport for the operator UI's Install capability and Edit model flows: the deployed harness clones its own managed repo via SSH using a per-deployment `GITHUB_DEPLOY_KEY`, runs the same pure planner/mutator the wizard used to run, and pushes the commit directly. No wizard in the path.
  - Wizard scaffold flow (`/new`) generates an ed25519 keypair, registers the public half on the new repo as a deploy key with write access, and surfaces the private key + `GITHUB_DEPLOY_REPO_SSH_URL` on the scaffold-done page with copy buttons for the Render Blueprint env-var prompt.
  - CLI-scaffolded harnesses can self-serve via the new `npx create-render-agent deploy-key [--repo owner/name]` subcommand — generates a keypair and prints paste-ready instructions for the GitHub deploy-key page and the Render Environment tab.
  - Add agent (`POST /agents/add`) still proxies through the wizard with `WIZARD_SHARED_SECRET` in Wave 1 (it depends on runtime-entries templates that live in `create-render-agent`); a follow-up minor cut will move it to the deploy-key path too. Until then, keep `WIZARD_SHARED_SECRET` set alongside the deploy-key vars if you use Add agent.

  **What changed in the published API**
  - `@render-harness/registry` exports two new subpaths:
    - `@render-harness/registry/deploy-keys` — pure `generateDeployKeypair()` returning OpenSSH-format ed25519 keys, suitable for both wizard scaffold and the CLI subcommand. Shared so both stay byte-identical.
    - `@render-harness/registry/repo-mutations` — re-export of the pure `planCapabilityInstall`, `mutateCapabilityInstallYaml`, `mutateAgentModel`, `planAgentAdd`, etc., previously private to the wizard. Consumed by both the wizard's existing routes and the harness's new deploy-key commit path so they share one implementation of every YAML mutation.
  - `@render-harness/contracts` adds `repoSshUrl?: string | null` to `DeploymentInfo.repoLocator`. Backfilled in `enrichDeploymentInfo` from `org` + `repo` as `git@github.com:<org>/<repo>.git` when an explicit SSH URL isn't pinned in `.render-harness/agent.json`.
  - `@render-harness/web` adds `packages/web/src/lib/git-commit.ts` (`withRepoClone`, `commitFilesToRepo`) plus `packages/web/src/lib/commit-shim.ts` (`pickCommitPath`). The `capability-install` and `agent-model` routes wire these in with a back-compat fallback to the wizard proxy when `WIZARD_SHARED_SECRET` is set but `GITHUB_DEPLOY_KEY` isn't.
  - `@render-harness/registry/emitter` adds `GITHUB_DEPLOY_KEY` and `GITHUB_DEPLOY_REPO_SSH_URL` as `sync: false` envVars on every UI-enabled web service in the generated `render.yaml`. The Config tab's `implicitOperationalVars` learns about both; `WIZARD_SHARED_SECRET`'s description is reworded as legacy.
  - `create-render-agent`'s `.env.example` template appends commented-out `GITHUB_DEPLOY_KEY` / `GITHUB_DEPLOY_REPO_SSH_URL` blocks (only when `ui: true`) alongside the existing `WEB_API_KEY` / `UI_COOKIE_SECRET` block.

  **Deprecation**

  The wizard's `/api/capabilities/install`, `/api/agents/add`, `/api/agents/:slug/model` routes still accept `Authorization: Bearer WIZARD_SHARED_SECRET` and continue to function for harnesses scaffolded before this cut. Each route logs a one-shot deprecation warning on first authenticated hit per process. These endpoints will be removed in a future minor cut; rotate harnesses to deploy keys when convenient. See `docs-site/src/content/docs/managed-repo-commits.mdx` for the operator-facing setup walkthrough.

  **Runtime requirements**

  The deploy-key flow shells out to the system `git` binary plus OpenSSH client (`ssh`). Both are present in Render's native Node runtime per https://render.com/docs/native-runtimes#tools-and-utilities. Custom Dockerfile users should ensure `git` and `openssh-client` are installed; the harness defensively probes at first use and surfaces an actionable `git binary not on PATH` error if missing.

  **Why coordinated minor**

  Per `AGENTS.md` "Minor bumps must be coordinated across the whole family" — `@render-harness/registry`, `@render-harness/contracts`, and `@render-harness/web` ship breaking-shape changes (new exports, new `repoLocator.repoSshUrl` field, new commit-shim route shape) and the runtime version check would red-banner every existing managed harness if any first-party package crossed 0.7 without the rest. Every first-party package + every capability pack bumps to 0.7.0 together.

### Patch Changes

- Updated dependencies [0a772da]
- Updated dependencies [ab4dbd1]
  - @render-harness/core@0.7.0
  - @render-harness/contracts@0.7.0

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

## 0.5.1

### Patch Changes

- Auto-configure the operator UI's Install capability flow so installing a pack into an existing harness "just works".

  **Every official pack is installable through the modal.** `OFFICIAL_CAPABILITY_INSTALLS` in the wizard previously only covered 4 packs (`cap-slack`, `cap-github`, `cap-linear`, `cap-webhook-generic`); picking any of the 7 others (`cap-search-exa`, `cap-search-tavily`, `cap-scrape-firecrawl`, `cap-google`, `cap-memory-pg`, `cap-filesystem`, `cap-browser-browserbase`) was impossible from the UI and would 400 with `unknown_capability` even if the request were hand-crafted. The map now covers all 11 published packs, each with `label`, `description`, read/write tool names, env vars, connector flag, and an optional caveat surfaced inline in the modal.

  **New `/api/capabilities/catalog` endpoint** on the wizard serializes the map; the deployed harness exposes a same-origin `/capabilities/catalog` proxy mirroring the existing `/agents/catalog` proxy (60s in-process cache, 401 unauth, 503 when the wizard URL is unset). The Install capability modal now fetches this catalog on mount instead of carrying a hardcoded 4-pack list, so the modal stays in sync with whatever the wizard knows without a UI redeploy. Pack-specific config inputs (e.g. Slack's allowed channels) and the access-mode toggle are gated on whether the selected pack has write tools, and a pack-specific description + caveat panel renders alongside the selector.

  **Tier A builtins now ride along when the wizard expands `allowedTools`.** Previously, installing any capability into an agent whose template ships a restrictive `shared.permissions.allowedTools` (the support-bot gallery template does) silently stripped `load_skill`, `fetch_full_result`, `fetch_url`, `current_time`, `ask_user`, and `todo` from the model's tool catalog — those are "always on" by core's design, but a strict allowlist filters them out at request time anyway. The mutator now ensures every Tier A name lands in the allowlist alongside the pack's tools. Critically, the mutator no longer introduces an `allowedTools` allowlist when the agent didn't already have one (the previous behaviour silently turned every open agent into "only these N tools allowed" on the first install).

  **`POST /api/agents/add` also expands `allowedTools` for any capability the bundle pulls in.** Adding research-cron to a restrictive agent no longer leaves the new cron unable to call its Exa search tools. The expansion is read-only by default (operators can upgrade to read+write via the Install capability modal); a warning per added pack surfaces in the route response so the operator UI can show what shifted.

  The user-facing chain: pick "Exa web search" in the Install capability modal -> the wizard commits `cap-search-exa` to `capabilities[]`, grows `allowedTools` with the Exa MCP tool names plus the Tier A builtins, and Render auto-deploys. The model immediately sees `web_search_exa` / `web_fetch_exa` / `web_search_advanced_exa` in its toolset alongside `load_skill` and friends.

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
  - @render-harness/contracts@0.4.0

    0.3.0##

### Minor Changes

- Coordinated 0.3.0 baseline cut across the entire first-party harness family.
  See AGENTS.md § "Minor bumps must be coordinated across the whole family".

## 0.2.5

### Patch Changes

- 70ab0f4: Zero-config Add agent in the deployed harness.
  - `@render-harness/web`: new `GET /agents/catalog` route proxies the wizard catalog same-origin so the browser never crosses origins (the wizard ships no CORS headers). Response is cached in-process for 60s. The proxy and the existing add/install/edit-model routes now default the wizard URL server-side; `RENDER_HARNESS_WIZARD_URL` becomes an opt-in override.
  - `@render-harness/wizard`: `listAddableAgents` now flattens every gallery entry, not just bundles. `planAgentAdd` accepts agents that reference a builtin (no `agent.entrypoint`) and produces a null `sourceFilePath` so the route skips the src/ probe and write. Single-agent gallery entries (chat, support-bot, research-cron, work-monitor) are addable from the operator UI.
  - `@render-harness/registry`: `enrichDeploymentInfo` defaults `wizardServiceUrl` to the public wizard. The Config tab's description of `RENDER_HARNESS_WIZARD_URL` is reworded to "override only" and `WIZARD_SHARED_SECRET`'s description is clarified. The gallery loader walks `src/` for every entry kind so single-agent entries that ship custom source are picked up too.
  - `@render-harness/ui`: Add agent panel is always visible on the Agents tab and shows a one-line hint when the deployment can't commit (missing repo locator / shared secret). The catalog modal swaps the flat `<select>` for a filterable card grid, surfaces actionable error codes (`needs_install`, `wizard_shared_secret_not_configured`, `repo_locator_missing`, `wizard_service_not_configured`), and reuses `useDeployWatch` + the toaster so successful adds show committed → restarting → restored with a Reload action.

## 0.2.4

### Patch Changes

- toaster for changes pushed to render
- Updated dependencies
  - @render-harness/contracts@0.2.2
  - @render-harness/core@0.2.2

## 0.2.3

### Patch Changes

- fixes

## 0.2.2

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

## 0.2.1

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/contracts@0.2.1
  - @render-harness/core@0.2.1

## 0.2.0

### Minor Changes

- Realign with the rest of the `@render-harness/*` harness family at `0.2.0`. No code changes — version bump only, so `create-render-agent` scaffolds that pin every `@render-harness/*` dep to `^0.2` resolve `ui` too.

## 0.1.5

### Patch Changes

- Fix module-script MIME-type errors when the operator UI is mounted at root (`path: "/"`). The SPA shell references hashed asset bundles at top-level paths (e.g. `/chunk-CSCIHK7Q-Bo3glXo1.js`); the mount now serves them from `bundled-gallery`'s `static/assets/` for the root-mount case instead of falling through to the SPA HTML.

## 0.1.4

### Patch Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.
- Updated dependencies [6952832]
  - @render-harness/contracts@0.2.0
  - @render-harness/core@0.2.0
