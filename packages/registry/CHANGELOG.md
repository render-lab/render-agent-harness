# @render-harness/registry

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
