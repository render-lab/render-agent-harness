# @render-harness/ui

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
