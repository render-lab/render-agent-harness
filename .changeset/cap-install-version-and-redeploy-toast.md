---
"@render-harness/registry": patch
"@render-harness/ui": patch
---

Two operator-UI bugs surfaced by the first real-world post-0.7.0 capability install:

**1. Install map pinned every cap to a stale minor line.** `OFFICIAL_CAPABILITY_INSTALLS` in `@render-harness/registry/repo-mutations` carried hardcoded `versionRange: "^0.5.0"` (and `^0.1.1` for older entries) for every pack — installing cap-google from the operator UI on a 0.7.0 harness wrote `"@render-harness/cap-google": "^0.5.0"` into package.json, which pins the dep to the 0.5.x line and trips the runtime version check (mixed minors across the family). Bumped every literal to `^0.7.0`.

Also added 5 missing entries the Wave 1 cuts shipped without: `cap-render`, `cap-notion`, `cap-intercom`, `cap-granola`, `cap-figma`. These packs were in the gallery but couldn't be installed from the operator UI.

To prevent recurrence: new regression test in `packages/registry/src/repo-mutations/capability-install.versions.test.ts` walks `packages/capabilities/*/package.json` from the workspace, computes the expected `^<major.minor.0>` range, and fails if any catalog entry drifts (either wrong version OR missing entirely). Next coordinated minor cut will trip this test in CI and surface a clear fix message.

**2. Install capability had no post-commit feedback.** `InstallCapabilityModal`'s `onInstalled` callback set a static notice and returned. After the commit landed on the managed repo, Render auto-deployed but the operator got no signal — nothing visible until they reloaded the page minutes later. Rewired the `AgentsTab` callback to also call `startRedeployWatch(message)`, the same committed → restarting → restored toast chain Add agent already uses. Operator now sees a Reload action once the new pack is live.
