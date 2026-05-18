# @render-harness/ui

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
