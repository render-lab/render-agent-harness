# Publish plan: shipping the harness to npm

## Context

Today the harness is internally consistent — 19 workspace packages, all named `@render-harness/*`, all using `workspace:*` deps. The `@render-harness` scope does not exist on npm; nothing has been published. Two things downstream of that:

- Scaffolded projects from `create-render-agent` pin `@render-harness/* @ ^0.1` and fail to install against npm. The recently-shipped `--harness-root <path>` flag works around this by emitting `link:` deps to a local checkout (see [`cli-scaffolder-plan.md`](./cli-scaffolder-plan.md)). The workaround is enough for harness contributors but not for the end user `npx create-render-agent` is supposed to serve.
- The chosen npm scope is **`@render-lab`**, not `@render-harness`. So publishing isn't just "turn on npm publish" — it requires a coordinated package-name rename across the repo, the registry's schema, capability-pack discovery keywords, the CLI scaffolder's templates, the example apps, and the bundled gallery.

This plan covers (1) the rename, (2) a `changesets`-driven release pipeline, (3) the GitHub Actions workflow, (4) the first publish, and (5) ripping out the local-link workaround once it's no longer load-bearing.

Out of scope here: the UI scaffolder, the admin UI, gallery website, any new product surfaces. Pure infrastructure work.

## Dependencies

- The `@render-lab` npm org must exist and the publishing identity (user or bot) must have publish permissions. **Blocking item — confirm before starting work.**
- The `render-lab/render-agent-harness` GitHub repo's Actions need access to an `NPM_TOKEN` secret with publish rights. (Trusted publishers via OIDC is the modern alternative; flagged as an open question in §5.)
- The CLI scaffolder (Phase 1) and gallery (Phase 2) must remain working end-to-end across the rename. The renames are atomic per-PR; tests catch drift.

## Architecture

### 3.1 Naming: rename `@render-harness/*` → `@render-lab/*`

**Affected packages** (19, every one renames):

| Today | After |
|---|---|
| `@render-harness/core` | `@render-lab/core` |
| `@render-harness/contracts` | `@render-lab/contracts` |
| `@render-harness/registry` | `@render-lab/registry` |
| `@render-harness/runtime-web` | `@render-lab/runtime-web` |
| `@render-harness/runtime-cron` | `@render-lab/runtime-cron` |
| `@render-harness/runtime-worker` | `@render-lab/runtime-worker` |
| `@render-harness/runtime-workflows` | `@render-lab/runtime-workflows` |
| `@render-harness/web` | `@render-lab/web` |
| `@render-harness/ui` | `@render-lab/ui` |
| `@render-harness/cap-*` (×6) | `@render-lab/cap-*` |
| `@render-harness/example-*` (private) | unchanged (`private: true`, never published) |

The `create-render-agent` package keeps its unscoped name (it's the official `create-*` convention; reserving the bare name is part of the publish step).

**Mechanical rename surface** — every place the literal `@render-harness/` string appears, which spans:

- `packages/*/package.json` and `packages/capabilities/*/package.json` — `name`, `dependencies`, `devDependencies`.
- TypeScript imports across all packages (`from "@render-harness/core"` etc.).
- `packages/registry/src/schema.ts` — the `CapabilityRefSchema.pack` regex and validator messages mention the scope. The schema's `discovery keyword` (`render-harness-cap` in each capability's `package.json` `keywords`) stays — that's a discovery convention, not a package-name claim.
- `packages/registry/src/gallery.ts` — the discovery walker matches by keyword, not by scope, so it survives. But labels and tests reference the scope and need updating.
- `packages/create-render-agent/src/templates/*` — every template that emits `@render-harness/*` (mostly `package-json.ts`, `runtime-entries.ts`, `agent-index.ts`).
- `packages/create-render-agent/src/prompts.ts` — `KNOWN_*` defaults; capability validation regex if any.
- `examples/*/package.json` and `examples/*/src/*.ts` imports.
- `templates/render-harness-entry/` — the in-repo starter the CLI's templates mirror.
- `gallery/index.yaml` and `gallery/agents/*/render-harness.yaml` — capability pack references.
- `docs/*.md` — every cross-reference.
- `CLAUDE.md` — the runtime / capability scope mentions.

**Strategy** — one PR that does the rename in a single mechanical pass, with an automated `find . -type f \( -name '*.ts' -o -name '*.json' -o -name '*.yaml' -o -name '*.md' \) -exec sed -i ''` (or a small script) and a follow-up commit fixing whatever the rename misses. Then run `pnpm install` to update the lockfile, `pnpm test`, `pnpm typecheck`, and `pnpm build` to confirm nothing broke. **Do not split this rename across multiple PRs** — the workspace breaks halfway through.

The repo's internal directory layout (`packages/core`, `packages/capabilities/cap-*`, etc.) stays — only the published `name` field changes. This keeps `--harness-root` link paths stable.

### 3.2 Versioning + release pipeline: changesets

The repo currently uses a single `0.1.0` version across every package, applied by hand. That's fine for prerelease but breaks down once consumers depend on the published packages and need to know what changed.

Adopt [**changesets**](https://github.com/changesets/changesets):

- `.changeset/config.json` declares: `"access": "public"`, fixed version policy across `@render-lab/*` (everything bumps together for v0.x — saves us from per-package semver until the surface stabilizes), ignored packages (`examples/*`, the private root).
- Contributors write a `.changeset/<random>.md` describing what changed and at what version bump (patch/minor/major). PRs without a changeset for non-trivial changes are flagged by a CI check (the `changesets/action` Action does this).
- A "Release" PR is auto-opened by the release workflow when changesets accumulate on `main`. Merging it applies the version bumps and publishes.

**Why fixed (not independent) versioning**: 15 of 19 packages share a `workspace:*` graph; independent versions amplify the cognitive load (which runtime-web version pairs with which core?) for negligible benefit at v0.x. Revisit when v1.0 ships and the package surface settles.

**One-commit migration**: install `@changesets/cli`, run `pnpm changeset init`, edit the config, commit. No cross-package changes required.

### 3.3 GitHub Actions release workflow

New file `.github/workflows/release.yml`. Two jobs:

1. **`test`** — runs on every PR and every push to `main`. `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm check` (biome). Status check required to merge.
2. **`release`** — runs on push to `main` only. Uses `changesets/action`:
   - If changesets are queued, opens or updates the "Version Packages" PR.
   - If the "Version Packages" PR was just merged (no changesets remaining, version bumps applied), runs `pnpm -r build` then `pnpm -r publish --access public --no-git-checks` against the `NPM_TOKEN` secret.

The `release` job needs:
- `NPM_TOKEN` repo secret OR (better) [npm trusted publishers via OIDC](https://docs.npmjs.com/trusted-publishers). The OIDC route doesn't need a long-lived token, signs builds with provenance, and is recommended for new packages. **Open question §5 — pick one.**
- `permissions.contents: write` so the workflow can push the version-bump commit.
- `permissions.pull-requests: write` so it can open the Release PR.
- `permissions.id-token: write` (if OIDC publishing).

A separate, manual workflow file `release-canary.yml` publishes a `0.0.0-canary-<sha>` from any branch on demand for testing. Not blocking v1, but cheap and useful.

### 3.4 CLI scaffolder updates at publish time

When the harness publishes its first `@render-lab/*` version, the CLI templates need to flip from `@render-harness/*` (no-longer-existing) to `@render-lab/*` in:

- `packages/create-render-agent/src/templates/package-json.ts` — dep names + `harnessDepVersion` resolution.
- `packages/create-render-agent/src/templates/agent-index.ts` — the `defineFromConfig` import.
- `packages/create-render-agent/src/templates/runtime-entries.ts` — `serveAgent` / `serveWeb` / `runCronAndExit` / `startWorkerAndWait` imports.
- `packages/create-render-agent/src/prompts.ts` — the default capability list and `KNOWN_MODELS`/labels if they mention the scope.
- `gallery/index.yaml` + `gallery/agents/*/render-harness.yaml` — capability `pack:` references.
- Re-run `pnpm bundle-gallery` so the published snapshot reflects the new names.

This is the same edit-pass that did §3.1, just in reverse direction (in-repo source already says `@render-lab/*` by then; the templates emit it).

**Local-link mode (`--harness-root`)**: the resolution helper in `package-json.ts` keeps working as-is — it strips the scope and rebuilds the path — but the scope prefix becomes `@render-lab/` instead of `@render-harness/`. One-line change.

### 3.5 Decommissioning the local-link workaround

Once `@render-lab/*` is on npm at a working version:

- The "Heads-up" banner in scaffolded READMEs (added by `harnessDepNote` in `readme.ts`) becomes dead code; remove it.
- `--harness-root` stays — it remains useful for harness contributors iterating on the registry/runtimes while testing the CLI. The flag's docstring updates to reflect that it's now a contributor-only flag, not a workaround.
- Remove the inline note in `bin.ts`'s `USAGE` mentioning "Use this until the harness is published to npm" — keep just the contributor-mode framing.

## File-by-file changes (per phase)

### Phase A — rename (one PR)

- All `packages/*/package.json` and `packages/capabilities/*/package.json`: `name`, `dependencies` (`@render-harness/*` → `@render-lab/*`).
- All `packages/*/src/**/*.ts`: imports.
- `packages/registry/src/schema.ts`: regex / validator messages.
- All `examples/*/package.json` and `examples/*/src/**/*.ts`.
- `templates/render-harness-entry/package.json` and `agent/index.ts` and `src/main.ts`.
- `gallery/index.yaml` and `gallery/agents/*/render-harness.yaml`.
- `packages/create-render-agent/src/templates/*.ts`.
- `packages/create-render-agent/src/prompts.ts` (if it references the scope directly anywhere — currently only via capability names from the gallery, which are data-driven, so likely no-op).
- `docs/*.md`: cross-references.
- `CLAUDE.md`: scope mentions.
- `pnpm-lock.yaml`: regenerated.
- Re-bundle the gallery via `pnpm --filter create-render-agent prebuild`.

Verification: `pnpm typecheck && pnpm test && pnpm build && pnpm check`. Tests must pass without snapshot updates (no behaviour change, only names).

### Phase B — changesets (one PR)

- `.changeset/config.json` (new).
- `.changeset/README.md` (new, auto-generated).
- Root `package.json`: add `@changesets/cli` to devDependencies; add `release` and `version` scripts.
- Initial changeset entry establishing 0.1.0 as the first published version.

### Phase C — GHA release workflow (one PR)

- `.github/workflows/release.yml` (new).
- `.github/workflows/release-canary.yml` (new, optional).
- Repo settings: add `NPM_TOKEN` secret OR configure the trusted-publisher relationship (one-time, in the repo settings + npm account).

### Phase D — first publish (zero-code; merge the Version Packages PR)

- Changesets opens a Release PR with version bumps from `workspace:*` resolution to literal versions in published packages.
- Merging triggers `pnpm -r publish`. Watch the workflow run; verify all `@render-lab/*` show up on npm.
- The `create-render-agent` CLI is published as part of the same flow (it's in the workspace and has a changeset).

### Phase E — CLI template flip + workaround sunset (one PR)

- The scope-flip edits in `packages/create-render-agent/src/templates/*.ts` and `gallery/*`.
- README-template tweaks to remove the "not published" banner.
- `pnpm build` + manual smoke: scaffold a project _without_ `--harness-root`, run `pnpm install` — should now resolve against npm.

## Reused existing primitives

- `pnpm` workspaces + `workspace:*` already in place; changesets understands the protocol natively.
- The `--harness-root` flag stays — phase E preserves it as a contributor convenience.
- Existing biome + vitest configs; no additional tooling.
- `pnpm -r build` already chains every package; changesets-publish builds before publishing.

## Open questions

1. **Trusted publishers vs `NPM_TOKEN`.** Trusted publishers (OIDC) is more secure and gives free provenance attestation; needs a one-time config step on the npm side. `NPM_TOKEN` is the legacy path, simpler to set up but rotates poorly. Recommend trusted publishers but flag.
2. **`create-render-agent` namespace.** Currently unscoped. We could also publish it as `@render-lab/create-render-agent` to keep the org tidy, but unscoped is the npm convention for `create-*` (`npm init <name>` resolves `create-<name>`). Stick with unscoped — confirmed available on npm.
3. **Fixed vs independent versioning.** Plan recommends fixed for v0.x; revisit at v1.0. Marking as a decision, not blocking.
4. **Examples + templates publish status.** `examples/*` and `templates/render-harness-entry` are `private: true` today; should they ship for users who want to clone? Recommend keeping them in-repo only; they travel via git, not npm.
5. **Rollback story.** First few publishes will have bugs. Plan should call out that `npm unpublish` has a 72-hour window and we should be ready with a patch-release path rather than unpublish.

## Verification

After phase A: the workspace builds clean with the new names, all 28 CLI tests + 27 registry tests pass, biome is green.

After phase D (first publish):

```sh
# In an empty directory, with no harness checkout in sight.
npm view @render-lab/core version           # returns 0.1.0
npx create-render-agent my-agent            # wizard runs, picks bundled gallery
cd my-agent
pnpm install                                # resolves @render-lab/* from npm
pnpm db:up && pnpm dev                      # local server boots, /healthz responds
```

After phase E: the same flow works without `--harness-root` from a fresh clone of nothing.

## Execution order

1. **Phase A — rename.** One mechanical PR. Highest risk; merge fast, fix forward if anything breaks downstream.
2. **Phase B — changesets.** Trivial; depends only on phase A being merged.
3. **Phase C — release workflow.** Wire the secret / OIDC trust _before_ the workflow file lands (otherwise the first run fails noisily). Then merge the workflow.
4. **Phase D — first publish.** Run `pnpm changeset` describing the initial v0.1.0 release; merge the Release PR. Verify on npmjs.com.
5. **Phase E — CLI template flip.** After phase D's publish is confirmed working. Re-test scaffolding from a clean dir as the post-publish verification.

Steps 1–3 are independent of any user-visible work happening on the project; can run anytime. Step 4 is the moment of truth. Step 5 unblocks the public `npx create-render-agent` story end-to-end.
