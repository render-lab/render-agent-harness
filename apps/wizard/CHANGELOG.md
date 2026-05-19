# @render-harness/wizard

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
