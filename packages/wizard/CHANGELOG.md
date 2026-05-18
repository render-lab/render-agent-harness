# @render-harness/wizard

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
