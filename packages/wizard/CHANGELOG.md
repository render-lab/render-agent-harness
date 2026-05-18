# @render-harness/wizard

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
