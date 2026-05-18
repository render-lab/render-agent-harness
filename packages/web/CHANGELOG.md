# @render-harness/web

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
