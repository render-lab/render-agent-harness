# AGENTS.md

Repo-specific guidance for AI coding agents (Claude Code, Cursor, Codex, etc.). This file complements `CLAUDE.md` (which captures repo shape, commands, and architecture) by documenting gotchas you cannot infer from a quick directory listing.

Read this whenever a task touches versioning, publishing, scaffolding, snapshots, or capability packs.

## Versioning model: independent, not lockstep

The `@render-harness/*` family does **not** move in lockstep. Different packages live on different version tracks for deliberate reasons:

- **Core (`core`, `contracts`, `registry`, `runtime-*`)** — bump together when the shared substrate changes.
- **Dependents (`web`, `wizard`)** — cascade-bumped by Changesets' `updateInternalDependencies: "patch"` policy whenever their internal harness deps change. They will always be one patch ahead of `core` immediately after a `core` bump.
- **UI (`ui`)** — has its own line because the SPA bundle changes independently of the harness substrate.
- **Capabilities (`packages/capabilities/cap-*`)** — explicitly independent. Bump only when the capability itself changes; they ship their own minor/patch deltas.

`@render-harness/registry`'s `buildHarnessVersionInfo` is aware of this: it doesn't flag patch-level drift as long as every installed version still satisfies the consumer's declared `harnessVersion` range. **Do not add a "strict uniqueness" check back in.** If you need to assert that core packages move together, scope it to the core list only, not all first-party packages.

The Changesets config (`.changeset/config.json`) keeps `linked: []` empty on purpose. Linking already-drifted packages forces Changesets into a major-version reconciliation (every package jumps to the next `1.0.0`), which is never what we want.

## Realigning a drifted package

When a package drifts onto its own minor line (e.g. `ui@0.1.x` while the family is on `0.2.x`), do **not** use a Changesets minor bump — Changesets will treat the `0.x → 0.(x+1)` crossing as breaking and cascade a major bump to every dependent.

Instead:

1. Manually edit the package's `version` in `package.json`.
2. Prepend a `## <new-version>` entry to its `CHANGELOG.md` explaining the realignment.
3. Run `pnpm install --lockfile-only`.
4. Commit + push as a normal `chore(<pkg>): realign to X.Y.Z` change.

This is what was done for `@render-harness/ui@0.1.5 → 0.2.0` and the six `0.1.x` capability packs.

## Scaffolder snapshot tests

`packages/create-render-agent/src/generate.test.ts` runs `buildFileMap()` against six representative runtime combos and captures the entire generated file map (`package.json`, `render-harness.yaml`, `src/*.ts`, `README.md`, `.env.example`, `tsup.config.ts`, etc.) into a single vitest snapshot at `src/__snapshots__/generate.test.ts.snap`. The snapshot's job is to catch unintended changes in scaffolder output during refactors.

**The test stubs `./version-ranges.js` via `vi.mock`** so both `DEFAULT_HARNESS_VERSION_RANGE` and `harnessVersionRangeFor()` return `^0.0.0-test`. Without this stub, the snapshot would bake whatever value the workspace happens to be on at test time, and every harness bump would re-churn the snapshot file (we hit that twice in May 2026 before adding the stub). If you add a new export to `version-ranges.ts`, extend the mock or the test will fail with "is not a function".

When you intentionally change the scaffolder's output:

1. Make the source change.
2. Run `pnpm --filter create-render-agent test` — expect a snapshot diff.
3. Inspect the diff: it should only show fields you changed, never the `@render-harness/*` version range (that stays `^0.0.0-test`).
4. If the diff looks right, refresh with `pnpm --filter create-render-agent exec vitest run -u`.
5. Commit the snapshot update alongside the source change.

If you see `^0.x.y` literals (real versions) leak into the snapshot, the stub broke — fix the mock, don't accept the leaked snapshot.

## Releasing packages

The release flow is npm Trusted Publishing (OIDC) via GitHub Actions, not long-lived `NPM_TOKEN`. See `.github/workflows/release.yml`.

Requirements that must hold for a publish to succeed:

- The workflow's `permissions: id-token: write` is set (already in the YAML).
- Every publishable package has `repository.url` pointing exactly at the GitHub repo (`scripts/add-repository-fields.mjs` keeps this in sync — re-run it after adding a new package).
- Every publishable package's `exports` field includes `"./package.json": "./package.json"` so `@render-harness/registry`'s `readPackageVersion` can probe installed versions (`scripts/expose-package-json-exports.mjs` keeps this in sync).
- The repo is **public on GitHub** (npm refuses provenance attestations from internal/private repos).
- Each package has a **Trusted Publisher** configured on npmjs.com pointing at:
  - Org: `render-lab`
  - Repo: `render-agent-harness`
  - Workflow filename: `release.yml` (just the filename, no `.github/workflows/` prefix; **note the spelling: `.yml`, not `.yaml`**)
  - Environment: empty
- The publish step does **not** set `NPM_TOKEN` or `NODE_AUTH_TOKEN`. With those unset, npm falls through to OIDC.

When `pnpm release` (which runs `scripts/publish-unpublished.mjs`) reports a 404 for one specific package, the cause is almost always a misconfigured Trusted Publisher on that package's npm settings page. Don't reach for token-based auth as a workaround.

## Capability catalog and gallery versions

`capability-catalog/index.yaml` and `gallery/**/render-harness.yaml` keep literal `versionRange` / `requiresHarness` / `harnessVersion` values **for the live-source path only** (when users pass `--harness-root` or `--capability-catalog` to the CLI). The bundled snapshot used by the published CLI is overridden at build time by `packages/create-render-agent/scripts/bundle-gallery.ts`, which reads each capability's current `package.json` version and the workspace registry version, then stamps those into `bundled-gallery/capability-catalog.json` and `bundled-gallery/harness-version.json`.

Consequence: bumping a literal in the catalog YAML is fine for documentation accuracy, but it does **not** affect scaffolded `package.json` deps in published CLI tarballs. The bundled values always win.

## Bump cookbook

| Scenario | What to do |
|---|---|
| Bug fix in `core`/`registry`/runtime/contracts/ui | Changeset `patch` on the affected package. Dependents (`web`, `wizard`) cascade-bump automatically. |
| Bug fix in a capability pack | Changeset `patch` on just that capability. |
| New public API in `core`/`registry` | Changeset `minor`. Be mindful that `0.x` minors are "breaking" in semver-zero land. |
| Realign a drifted package onto the family version | Direct `package.json` + `CHANGELOG.md` edit. No changeset. (See "Realigning a drifted package" above.) |
| Catalog metadata change for an existing capability | Edit `capability-catalog/index.yaml`. No version bump needed unless the cap's code also changes. |

## Things that bit us recently (and how to avoid them)

- **Scaffolded projects requesting `^0.1.1` when published is `0.2.x`** — the prebuild script now derives version ranges from the live workspace. If you change how `version-ranges.ts` resolves the default, keep the bundled `harness-version.json` and `capability-catalog.json` as fallback sources.
- **Scaffolded `package.json` requesting `@render-harness/core@^0.2.2` when only `0.2.1` is published** — the scaffolder used to stamp one universal range (from `@render-harness/registry`) across every `@render-harness/*` dep, which broke whenever sibling packages drifted onto different patch tracks (registry cascades ahead of core/contracts/runtime-* on small patches). The bundle now writes per-package ranges into `bundled-gallery/harness-version.json` (`packages: { "@render-harness/core": "^0.2.1", "@render-harness/registry": "^0.2.2", … }`) and `package-json.ts` looks each one up via `harnessVersionRangeFor(pkgName)`. The `harnessVersion` field in scaffolded `render-harness.yaml` is anchored to `@render-harness/core` so the runtime mixed-version check stays satisfied across expected drift.
- **`agent: support-bot` carried over from a gallery template into a user-named project** — `buildHarnessConfig` rewrites `config.agent` to the scaffolded agent name. If you add another field that should be retargeted on copy-from-template, extend `retargetCapabilityConfig`.
- **`UI_COOKIE_SECRET=""` crashing the UI** — `packages/ui/src/auth.ts` treats empty as unset and falls back to a per-process ephemeral. Don't reintroduce a hard fail on missing/empty secrets in development.
