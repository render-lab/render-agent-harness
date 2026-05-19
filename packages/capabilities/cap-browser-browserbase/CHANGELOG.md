# @render-harness/cap-browser-browserbase

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

- Updated dependencies [2213ab0]
- Updated dependencies [0a772da]
  - @render-harness/registry@0.7.0

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
  - @render-harness/registry@0.6.0

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
  - @render-harness/registry@0.5.0

## 0.4.1

### Patch Changes

- @render-harness/registry@0.4.1

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
  - @render-harness/registry@0.4.0

    0.3.0##

### Minor Changes

- Coordinated 0.3.0 baseline cut across the entire first-party harness family.
  See AGENTS.md § "Minor bumps must be coordinated across the whole family".

## 0.2.2

### Patch Changes

- Updated dependencies [70ab0f4]
  - @render-harness/registry@0.2.4

## 0.2.1

### Patch Changes

- @render-harness/registry@0.2.3

## 0.2.0

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.2.2

## 0.1.5

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/registry@0.2.1

## 0.1.4

### Patch Changes

- Read capability pack metadata versions from package.json so runtime pack metadata matches the published npm version.

## 0.1.3

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/registry@0.2.0
