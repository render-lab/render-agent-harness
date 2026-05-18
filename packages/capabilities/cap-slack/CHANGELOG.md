# @render-harness/cap-slack

## 0.2.6

### Patch Changes

- Updated dependencies [70ab0f4]
  - @render-harness/registry@0.2.4

## 0.2.5

### Patch Changes

- @render-harness/registry@0.2.3

## 0.2.4

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.2.2

## 0.2.3

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/registry@0.2.1

## 0.2.2

### Patch Changes

- 24b0971: Allow connector packs to boot without provider API tokens by skipping local tools until env vars are configured.

## 0.2.1

### Patch Changes

- Read capability pack metadata versions from package.json so runtime pack metadata matches the published npm version.

## 0.2.0

### Minor Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/registry@0.2.0
