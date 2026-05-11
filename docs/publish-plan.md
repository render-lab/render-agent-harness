# Publish plan: shipping the harness to npm

## Context

Today the harness is internally consistent — 19 workspace packages, all named `@render-harness/*`, all using `workspace:*` deps. Nothing has been published. Two consequences:

- Scaffolded projects from `create-render-agent` pin `@render-harness/* @ ^0.1` and fail to install against npm because the packages aren't there yet. The recently-shipped `--harness-root <path>` flag works around this by emitting `link:` deps to a local checkout (see [`cli-scaffolder-plan.md`](./cli-scaffolder-plan.md)). The workaround is enough for harness contributors but not for the end user `npx create-render-agent` is meant to serve.
- The npm scope `@render-harness` does not exist yet and needs to be registered.

**Naming decision:** `@render-harness` is the npm scope. The GitHub org is `render-lab` (a broader umbrella that will host other projects). **npm scopes are independent of GitHub orgs** — many projects ship `@foo/*` from a GitHub org with a different name (e.g. `@types/*` packages come from `DefinitelyTyped/DefinitelyTyped`). Keeping `@render-harness` on npm gives short, project-specific names without forcing the org-wide `@render-lab` scope into being "the harness's scope."

This plan covers: (1) registering the npm scope, (2) a `changesets`-driven release pipeline, (3) the GitHub Actions release workflow, (4) the first publish, and (5) decommissioning the local-link workaround.

Out of scope here: the UI scaffolder, the admin UI, gallery website, any new product surfaces. Pure release infrastructure.

## Dependencies

- The `@render-harness` npm Organization must be registered at npmjs.com/org (free, 30-second self-service). The publishing identity (user or bot) must be a member with publish permissions. **Blocking item — confirm before starting.**
- The `render-lab/render-agent-harness` GitHub repo's Actions need access to an `NPM_TOKEN` secret with publish rights — *or*, preferred, the [npm trusted publishers via OIDC](https://docs.npmjs.com/trusted-publishers) relationship configured between this repo and the npm org. Open question §5.
- The CLI scaffolder (Phase 1) and gallery (Phase 2) must keep working across the publish; tests catch drift.

## Architecture

### 3.1 Versioning + release pipeline: changesets

The repo currently uses a single `0.1.0` version across every package, applied by hand. That's fine for prerelease but breaks down once consumers depend on the published packages and need to know what changed between versions.

Adopt [**changesets**](https://github.com/changesets/changesets):

- `.changeset/config.json` declares: `"access": "public"`, fixed version policy across `@render-harness/*` (everything bumps together for v0.x — saves us from per-package semver until the surface stabilizes), ignored packages (`examples/*`, the private root).
- Contributors write a `.changeset/<random>.md` describing what changed and at what version bump (patch/minor/major). PRs without a changeset for non-trivial changes are flagged by a CI check (the `changesets/action` Action does this).
- A "Release" PR is auto-opened by the release workflow when changesets accumulate on `main`. Merging it applies the version bumps and publishes.

**Why fixed (not independent) versioning**: 15 of 19 packages share a `workspace:*` graph; independent versions amplify cognitive load (which `runtime-web` version pairs with which `core`?) for negligible benefit at v0.x. Revisit when v1.0 ships and the package surface stabilizes.

**One-commit migration**: install `@changesets/cli`, run `pnpm changeset init`, edit the config, commit. No cross-package changes required.

### 3.2 GitHub Actions release workflow

New file `.github/workflows/release.yml`. Two jobs:

1. **`test`** — runs on every PR and every push to `main`. `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm check` (biome). Status check required to merge.
2. **`release`** — runs on push to `main` only. Uses `changesets/action`:
   - If changesets are queued, opens or updates the "Version Packages" PR.
   - If the "Version Packages" PR was just merged (no changesets remaining, version bumps applied), runs `pnpm -r build` then `pnpm -r publish --access public --no-git-checks` against the `NPM_TOKEN` secret (or via OIDC).

The `release` job needs:
- `NPM_TOKEN` repo secret OR (better) trusted-publisher OIDC relationship — see open question §5.
- `permissions.contents: write` so the workflow can push the version-bump commit.
- `permissions.pull-requests: write` so it can open the Release PR.
- `permissions.id-token: write` (if OIDC publishing).

A separate, manual workflow file `release-canary.yml` publishes a `0.0.0-canary-<sha>` from any branch on demand for testing. Not blocking v1, but cheap and useful.

### 3.3 First publish

Once changesets is wired and the workflow is live:

1. Author the initial changeset: `pnpm changeset` describing the v0.1.0 release. Commit.
2. Push to `main`. The `release` job opens a "Version Packages" PR that bumps every `@render-harness/*` package from `0.1.0` (the placeholder) to a real published `0.1.0` and resolves every `workspace:*` to a literal version range.
3. Merge the Version Packages PR. The next workflow run publishes all packages to npm.
4. Verify: `npm view @render-harness/core version` returns `0.1.0`. Same for every other package in the workspace.
5. `create-render-agent` ships in the same flow (it's a workspace package with its own changeset).

### 3.4 Decommissioning the local-link workaround

Once `@render-harness/*` is on npm at a working version, the in-CLI workaround becomes dead code:

- The "Heads-up — deps not on npm yet" banner in scaffolded READMEs (added by `harnessDepNote` in `packages/create-render-agent/src/templates/readme.ts`) is no longer needed; the `harnessRoot === null` branch should remove the banner or replace it with a positive "you're installing from npm" note.
- `--harness-root` stays — it remains useful for harness contributors iterating on the registry/runtimes while testing the CLI end-to-end. The flag's docstring updates to say "contributor convenience" rather than "workaround until publish."
- The inline note in `packages/create-render-agent/src/bin.ts` `USAGE` mentioning "Use this until the harness is published to npm" gets reworded.

No template flip needed — the templates already emit `@render-harness/*` deps, which IS the published scope.

## File-by-file changes (per phase)

### Phase A — changesets (one PR)

- `.changeset/config.json` (new).
- `.changeset/README.md` (new, auto-generated by `changeset init`).
- Root `package.json`: add `@changesets/cli` to devDependencies; add `release` and `version` scripts.
- Initial changeset entry describing v0.1.0.

### Phase B — GHA release workflow (one PR)

- `.github/workflows/release.yml` (new).
- `.github/workflows/test.yml` or merged into release.yml (depending on whether tests already have a workflow).
- `.github/workflows/release-canary.yml` (new, optional).
- One-time setup: register `@render-harness` on npmjs.com if not already done; configure trusted-publisher OR add `NPM_TOKEN` repo secret.

### Phase C — first publish (zero-code; merge the Version Packages PR)

- Author + merge the initial changeset.
- Merging the Version Packages PR triggers `pnpm -r publish`. Watch the workflow run; verify packages appear on npmjs.com.

### Phase D — workaround sunset (small PR after publish lands)

- `packages/create-render-agent/src/templates/readme.ts`: rework `harnessDepNote` to drop the "not published" warning.
- `packages/create-render-agent/src/bin.ts`: update `USAGE` to reflect contributor-mode framing for `--harness-root`.
- Manual smoke: scaffold a fresh project _without_ `--harness-root`, run `pnpm install` — should resolve from npm.

### Files explicitly NOT renamed

The original draft of this plan included a coordinated rename of every `@render-harness/*` package to `@render-lab/*`. **That phase has been cut** after the naming decision in §Context. No source files need rewriting before publish.

## Reused existing primitives

- `pnpm` workspaces + `workspace:*` deps — changesets understands the protocol natively and rewrites them to literal ranges at version time.
- Existing biome + vitest configs; no additional tooling.
- `pnpm -r build` already chains every package; changesets-publish runs it before publishing.

## Open questions

1. **Trusted publishers (OIDC) vs `NPM_TOKEN`.** OIDC is more secure (no long-lived token), provides free provenance attestation, and is recommended for new packages. Setup is one-time on the npm side. `NPM_TOKEN` is the legacy path: simpler initial setup, worse rotation story. Recommend OIDC.
2. **`create-render-agent` namespace.** Currently unscoped. Could also publish as `@render-harness/create-render-agent` to keep the org tidy, but unscoped is the npm convention for `create-*` (`npm init <name>` resolves `create-<name>`). Stick with unscoped — confirmed available on npm.
3. **Fixed vs independent versioning.** Plan recommends fixed for v0.x; revisit at v1.0. Not blocking.
4. **Examples + templates publish status.** `examples/*` and `templates/render-harness-entry` are `private: true` and travel via git, not npm. Confirm by gating them in the changesets config (ignored packages list).
5. **Rollback story.** First few publishes will have bugs. `npm unpublish` has a 72-hour window; beyond that, the path is a patch release. Plan should call out that patch-release is the default, unpublish is the escape hatch.
6. **Scoping the `@render-harness` npm org.** Owner/admin invites for the new npm org. Out-of-repo task; pick humans who can publish in an emergency.

## Verification

After Phase B (workflow lands but no publish yet):

- A "Version Packages" PR is auto-opened on the next push to `main` once a changeset exists.
- The workflow's `test` job runs on PRs and passes against the existing 14 (wizard) + 28 (CLI) + 27 (registry) + 21 (web) test suites.

After Phase C (first publish):

```sh
# In an empty directory, with no harness checkout in sight.
npm view @render-harness/core version            # returns 0.1.0
npx create-render-agent my-agent                 # wizard runs, picks bundled gallery
cd my-agent
pnpm install                                     # resolves @render-harness/* from npm
pnpm db:up && pnpm dev                           # local server boots, /healthz responds
```

After Phase D: the same flow works without the "deps not on npm yet" banner.

## Execution order

1. **Phase A — changesets.** Trivial; no dependencies. Merge first.
2. **Phase B — release workflow.** Wire the secret / OIDC trust _before_ the workflow file lands (otherwise the first run fails noisily). Then merge the workflow file.
3. **Phase C — first publish.** Run `pnpm changeset` describing the initial v0.1.0 release; merge the Release PR. Verify on npmjs.com.
4. **Phase D — workaround sunset.** After Phase C is confirmed working. Re-test scaffolding from a clean dir as the post-publish verification.

Steps 1–2 are independent of any user-visible work and can run anytime. Step 3 is the moment of truth. Step 4 unblocks the public `npx create-render-agent` story end-to-end.
