# create-render-agent

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
