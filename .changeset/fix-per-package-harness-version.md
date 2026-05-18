---
"create-render-agent": patch
---

Scaffolded projects now stamp each `@render-harness/*` dependency with
its own version range, derived from the corresponding workspace
package at bundle time. Previously the scaffolder used a single range
(taken from `@render-harness/registry`) across the whole family, which
broke `pnpm install` whenever sibling packages drifted onto different
patch tracks — e.g. `registry@0.2.2` shipping alongside `core@0.2.1`
caused `pnpm install` to fail with
`No matching version found for @render-harness/core@^0.2.2`. The
scaffolded `render-harness.yaml`'s `harnessVersion` field now anchors
to `@render-harness/core` (the most conservative substrate package),
so the registry's runtime mixed-version check stays satisfied across
expected patch-level drift.
