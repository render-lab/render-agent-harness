# @render-harness/wizard

## 0.6.0

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

- 2213ab0: Move `POST /agents/add` onto the deploy-key commit path. Completes Wave 1 of the edit-in-UI migration: all three flows (`capability-install`, `agent-model`, `agent-add`) now commit directly via the per-harness SSH deploy key when `GITHUB_DEPLOY_KEY` + `GITHUB_DEPLOY_REPO_SSH_URL` are set, and gracefully fall back to the legacy wizard-proxy path when only `WIZARD_SHARED_SECRET` is configured.

  Two new `@render-harness/registry` subpaths are introduced (both additive, no breaking changes):
  - `@render-harness/registry/runtime-entry-templates` holds the five `bundle*Entry` template functions previously in `packages/create-render-agent/src/templates/bundle.ts`. The CLI re-exports them so existing scaffold callers stay unchanged.
  - `@render-harness/registry/runtime-entries` holds `requiredEntries` + `ensureTsupEntries` (previously `apps/wizard/src/runtime-entries.ts`). The wizard re-exports them.

  `@render-harness/wizard` gains `GET /api/gallery/agents/:slug` returning `{ entry, capabilities }` for a single gallery entry. The harness's agent-add route fetches from it (60s in-process cache) so the harness doesn't need its own gallery loader. Older wizard builds without this endpoint cause the harness to fall back to the legacy `WIZARD_SHARED_SECRET` proxy when that's also configured, or surface `wizard_gallery_endpoint_missing` otherwise.

  `@render-harness/web`'s agent-add route now mirrors the shape of capability-install / agent-model: `pickCommitPath` picks deploy-key vs wizard-proxy at request time, the deploy-key branch runs the same planner + mutator + emitBlueprint sequence the wizard does (inside `withRepoClone`), and the response carries a `via: "deploy_key" | "wizard_proxy"` discriminator.

  All bumps stay within the `0.7.x` line; the runtime version check is satisfied without a coordinated minor.

- Updated dependencies [2213ab0]
- Updated dependencies [0a772da]
- Updated dependencies [ab4dbd1]
  - @render-harness/registry@0.7.0
  - @render-harness/core@0.7.0
  - create-render-agent@0.7.0

## 0.5.4

### Patch Changes

- Updated dependencies
  - @render-harness/core@0.6.0
  - @render-harness/registry@0.6.0
  - create-render-agent@0.6.0

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

- Stop emitting secret env vars with `value: ""` in the deployment-wide env group. The empty value made Render re-apply blank on every Blueprint sync — silently wiping whatever the operator had set in the Dashboard. Affected keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RENDER_API_KEY`, and any `envSchema` entry with `secret: true`.

  Render's env-group schema (`envVarFromKeyValue`) does support `sync: false`, even though it's only documented for service-level env vars. With `sync: false` the operator sets the value once in the Dashboard and Render preserves it across every subsequent reapply.

  Existing managed harnesses self-heal the next time the wizard re-emits their `render.yaml` (any `/api/agents/add` or `/api/capabilities/install` commit). Repos that haven't been touched in a while can patch by hand: replace each `value: ""` line under `envVarGroups[].envVars[]` with `sync: false` for the secret keys above.

  Also extends the wizard's `agent-add` flow (`mutatePackageJsonAddRuntimeDeps` in `packages/wizard/src/agent-add.ts`) to add `@render-harness/runtime-cron` / `runtime-workflows` to `package.json` when an added agent introduces a new runtime kind. Without this the freshly-written `src/cron.ts` would crash the build at esbuild resolve time:

  ```
  ✘ Could not resolve "@render-harness/runtime-cron"
  ```

  The version range is inherited from any existing `@render-harness/*` dep so the harness family stays on a single minor line.

- Updated dependencies
  - @render-harness/registry@0.5.1
  - create-render-agent@0.5.2

## 0.5.1

### Patch Changes

- Fix two distinct breakages in `POST /api/agents/add` that surfaced when a wizard-scaffolded harness added an agent introducing a new runtime kind (most commonly the gallery's `research-cron`).

  **Wrong `packageName` in the regenerated `render.yaml`.** The route was passing `cfg.name` (the manifest's deployment-suffixed slug) as the Blueprint emitter's `packageName`, but `package.json`'s `name` is the user-chosen agent name. The mismatch meant `pnpm --filter <deploymentName> build` matched no package in the workspace, silently no-op'd, and left `dist/` empty — every service then crashed at start with `Cannot find module dist/web.js`. The route now reads `package.json`'s `name` field and feeds it to `emitBlueprint`, mirroring what the scaffold does on initial repo creation.

  **Missing `src/<kind>.ts` and `tsup.config.ts` entries for newly introduced runtime kinds.** Adding a cron-runtime agent to a project that didn't have a cron before left the cron service trying to start `dist/cron.js` from a build step that never produced it. The route now computes which `dist/<X>.js` the freshly emitted `render.yaml` will reference, writes any missing `src/<X>.ts` from the bundled runtime templates (never overwriting an existing user-authored entry), and additively patches the `entry: { ... }` block in `tsup.config.ts` to include the new entries. Single-runtime layouts (`{ main: "src/main.ts" }`) are preserved verbatim alongside the appended entries. When `tsup.config.ts` can't be parsed, the route returns a warning so the user knows to add the entries by hand.

  `create-render-agent` now re-exports the `bundle*Entry` runtime templates so the wizard can reuse them without duplicating the bodies.

  Existing managed harnesses that already shipped a broken `render.yaml` recover the next time the wizard touches them (any `/api/agents/add` or `/api/capabilities/install` commit re-emits the Blueprint with the correct `packageName`).

- Updated dependencies
  - create-render-agent@0.5.1

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
  - @render-harness/registry@0.5.0
  - create-render-agent@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies
  - @render-harness/core@0.4.1
  - @render-harness/registry@0.4.1
  - create-render-agent@0.4.1

## 0.4.0

### Minor Changes

- Realign onto the 0.4.x family line alongside `@render-harness/web` and `create-render-agent`. See `@render-harness/web@0.4.0` for the rationale.

## 0.3.1

### Patch Changes

- Updated dependencies
  - @render-harness/core@0.4.0
  - @render-harness/registry@0.4.0
  - create-render-agent@0.3.1

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
  - create-render-agent@0.2.6

## 0.2.5

### Patch Changes

- @render-harness/core@0.2.2
- @render-harness/registry@0.2.3
- create-render-agent@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [95c6708]
  - create-render-agent@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.2.2
  - create-render-agent@0.2.3

## 0.2.2

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/core@0.2.1
  - @render-harness/registry@0.2.1
  - create-render-agent@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - create-render-agent@0.2.1

## 0.2.0

### Minor Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/core@0.2.0
  - @render-harness/registry@0.2.0
  - create-render-agent@0.2.0
