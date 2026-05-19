# @render-harness/registry

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

- Stop emitting secret env vars with `value: ""` in the deployment-wide env group. The empty value made Render re-apply blank on every Blueprint sync — silently wiping whatever the operator had set in the Dashboard. Affected keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RENDER_API_KEY`, and any `envSchema` entry with `secret: true`.

  Render's env-group schema (`envVarFromKeyValue`) does support `sync: false`, even though it's only documented for service-level env vars. With `sync: false` the operator sets the value once in the Dashboard and Render preserves it across every subsequent reapply.

  Existing managed harnesses self-heal the next time the wizard re-emits their `render.yaml` (any `/api/agents/add` or `/api/capabilities/install` commit). Repos that haven't been touched in a while can patch by hand: replace each `value: ""` line under `envVarGroups[].envVars[]` with `sync: false` for the secret keys above.

  Also extends the wizard's `agent-add` flow (`mutatePackageJsonAddRuntimeDeps` in `packages/wizard/src/agent-add.ts`) to add `@render-harness/runtime-cron` / `runtime-workflows` to `package.json` when an added agent introduces a new runtime kind. Without this the freshly-written `src/cron.ts` would crash the build at esbuild resolve time:

  ```
  ✘ Could not resolve "@render-harness/runtime-cron"
  ```

  The version range is inherited from any existing `@render-harness/*` dep so the harness family stays on a single minor line.

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

## 0.2.4

### Patch Changes

- 70ab0f4: Zero-config Add agent in the deployed harness.
  - `@render-harness/web`: new `GET /agents/catalog` route proxies the wizard catalog same-origin so the browser never crosses origins (the wizard ships no CORS headers). Response is cached in-process for 60s. The proxy and the existing add/install/edit-model routes now default the wizard URL server-side; `RENDER_HARNESS_WIZARD_URL` becomes an opt-in override.
  - `@render-harness/wizard`: `listAddableAgents` now flattens every gallery entry, not just bundles. `planAgentAdd` accepts agents that reference a builtin (no `agent.entrypoint`) and produces a null `sourceFilePath` so the route skips the src/ probe and write. Single-agent gallery entries (chat, support-bot, research-cron, work-monitor) are addable from the operator UI.
  - `@render-harness/registry`: `enrichDeploymentInfo` defaults `wizardServiceUrl` to the public wizard. The Config tab's description of `RENDER_HARNESS_WIZARD_URL` is reworded to "override only" and `WIZARD_SHARED_SECRET`'s description is clarified. The gallery loader walks `src/` for every entry kind so single-agent entries that ship custom source are picked up too.
  - `@render-harness/ui`: Add agent panel is always visible on the Agents tab and shows a one-line hint when the deployment can't commit (missing repo locator / shared secret). The catalog modal swaps the flat `<select>` for a filterable card grid, surfaces actionable error codes (`needs_install`, `wizard_shared_secret_not_configured`, `repo_locator_missing`, `wizard_service_not_configured`), and reuses `useDeployWatch` + the toaster so successful adds show committed → restarting → restored with a Reload action.

## 0.2.3

### Patch Changes

- Updated dependencies
  - @render-harness/contracts@0.2.2
  - @render-harness/core@0.2.2

## 0.2.2

### Patch Changes

- Relax `buildHarnessVersionInfo`'s mixed-version check. Patch-level drift across the harness family is expected: `@render-harness/web` cascade-bumps when its internal `@render-harness/ui` dep patches, and capability packs version on their own tracks. The previous logic flagged any unique-version count > 1 as a warning, which made the operator UI show "First-party harness packages are running mixed versions" even when every installed version still satisfied the declared range. The check now only warns when at least one running version falls outside the declared range.

## 0.2.1

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/contracts@0.2.1
  - @render-harness/core@0.2.1

## 0.2.0

### Minor Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/contracts@0.2.0
  - @render-harness/core@0.2.0
