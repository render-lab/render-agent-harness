# @render-harness/cap-scrape-firecrawl

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

- @render-harness/core@0.2.2
- @render-harness/registry@0.2.3

## 0.2.0

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.2.2

## 0.1.5

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/core@0.2.1
  - @render-harness/registry@0.2.1

## 0.1.4

### Patch Changes

- Read capability pack metadata versions from package.json so runtime pack metadata matches the published npm version.

## 0.1.3

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/core@0.2.0
  - @render-harness/registry@0.2.0
