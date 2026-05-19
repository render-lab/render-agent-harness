---
"@render-harness/registry": patch
"@render-harness/web": patch
"@render-harness/wizard": patch
---

Move `POST /agents/add` onto the deploy-key commit path. Completes Wave 1 of the edit-in-UI migration: all three flows (`capability-install`, `agent-model`, `agent-add`) now commit directly via the per-harness SSH deploy key when `GITHUB_DEPLOY_KEY` + `GITHUB_DEPLOY_REPO_SSH_URL` are set, and gracefully fall back to the legacy wizard-proxy path when only `WIZARD_SHARED_SECRET` is configured.

Two new `@render-harness/registry` subpaths are introduced (both additive, no breaking changes):

- `@render-harness/registry/runtime-entry-templates` holds the five `bundle*Entry` template functions previously in `packages/create-render-agent/src/templates/bundle.ts`. The CLI re-exports them so existing scaffold callers stay unchanged.
- `@render-harness/registry/runtime-entries` holds `requiredEntries` + `ensureTsupEntries` (previously `apps/wizard/src/runtime-entries.ts`). The wizard re-exports them.

`@render-harness/wizard` gains `GET /api/gallery/agents/:slug` returning `{ entry, capabilities }` for a single gallery entry. The harness's agent-add route fetches from it (60s in-process cache) so the harness doesn't need its own gallery loader. Older wizard builds without this endpoint cause the harness to fall back to the legacy `WIZARD_SHARED_SECRET` proxy when that's also configured, or surface `wizard_gallery_endpoint_missing` otherwise.

`@render-harness/web`'s agent-add route now mirrors the shape of capability-install / agent-model: `pickCommitPath` picks deploy-key vs wizard-proxy at request time, the deploy-key branch runs the same planner + mutator + emitBlueprint sequence the wizard does (inside `withRepoClone`), and the response carries a `via: "deploy_key" | "wizard_proxy"` discriminator.

All bumps stay within the `0.7.x` line; the runtime version check is satisfied without a coordinated minor.
