# create-render-agent

## 0.5.2

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.5.1

## 0.5.1

### Patch Changes

- Fix two distinct breakages in `POST /api/agents/add` that surfaced when a wizard-scaffolded harness added an agent introducing a new runtime kind (most commonly the gallery's `research-cron`).

  **Wrong `packageName` in the regenerated `render.yaml`.** The route was passing `cfg.name` (the manifest's deployment-suffixed slug) as the Blueprint emitter's `packageName`, but `package.json`'s `name` is the user-chosen agent name. The mismatch meant `pnpm --filter <deploymentName> build` matched no package in the workspace, silently no-op'd, and left `dist/` empty — every service then crashed at start with `Cannot find module dist/web.js`. The route now reads `package.json`'s `name` field and feeds it to `emitBlueprint`, mirroring what the scaffold does on initial repo creation.

  **Missing `src/<kind>.ts` and `tsup.config.ts` entries for newly introduced runtime kinds.** Adding a cron-runtime agent to a project that didn't have a cron before left the cron service trying to start `dist/cron.js` from a build step that never produced it. The route now computes which `dist/<X>.js` the freshly emitted `render.yaml` will reference, writes any missing `src/<X>.ts` from the bundled runtime templates (never overwriting an existing user-authored entry), and additively patches the `entry: { ... }` block in `tsup.config.ts` to include the new entries. Single-runtime layouts (`{ main: "src/main.ts" }`) are preserved verbatim alongside the appended entries. When `tsup.config.ts` can't be parsed, the route returns a warning so the user knows to add the entries by hand.

  `create-render-agent` now re-exports the `bundle*Entry` runtime templates so the wizard can reuse them without duplicating the bodies.

  Existing managed harnesses that already shipped a broken `render.yaml` recover the next time the wizard touches them (any `/api/agents/add` or `/api/capabilities/install` commit re-emits the Blueprint with the correct `packageName`).

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

- Realign onto the 0.4.x family line alongside `@render-harness/web` and `@render-harness/wizard`. See `@render-harness/web@0.4.0` for the rationale.

## 0.3.1

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.4.0

    0.3.0##

### Minor Changes

- Coordinated 0.3.0 baseline cut across the entire first-party harness family.
  See AGENTS.md § "Minor bumps must be coordinated across the whole family".

## 0.2.6

### Patch Changes

- Updated dependencies [70ab0f4]
  - @render-harness/registry@0.2.4

## 0.2.5

### Patch Changes

- @render-harness/registry@0.2.3

## 0.2.4

### Patch Changes

- 95c6708: Scaffolded projects now stamp each `@render-harness/*` dependency with
  its own version range, derived from the corresponding workspace
  package at bundle time. Previously the scaffolder used a single range
  (taken from `@render-harness/registry`) across the whole family, which
  broke `pnpm install` whenever sibling packages drifted onto different
  patch tracks — e.g. `registry@0.2.2` shipping alongside `core@0.2.1`
  caused `pnpm install` to fail with
  `No matching version found for @render-harness/core@^0.2.2`. The
  scaffolded `render-harness.yaml`'s `harnessVersion` field now anchors
  to `@render-harness/core` (the most conservative substrate package),
  so the registry's runtime mixed-version check stays satisfied across
  expected patch-level drift.

## 0.2.3

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.2.2

## 0.2.2

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/registry@0.2.1

## 0.2.1

### Patch Changes

- Fix scaffolded projects failing `npm install` due to outdated `@render-harness/*` dependency ranges, and fix capability configs keeping the template's agent id.
  - Prebuild now derives the harness version range and per-capability `versionRange` / `requiresHarness` from the live workspace `package.json`s and writes them into `bundled-gallery/`. Scaffolded `package.json`s and `render-harness.yaml`s no longer pin a stale `^0.1.1`.
  - `version-ranges.ts` resolves in order: bundled snapshot → `create-render-agent` own `@render-harness/registry` dep (rewritten on publish) → safe fallback.
  - `buildHarnessConfig` retargets each capability `config.agent` to the scaffolded agent id, so connector packs carried over from a gallery template (e.g. `support-bot`) dispatch to the new agent.

## 0.2.0

### Minor Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/registry@0.2.0
