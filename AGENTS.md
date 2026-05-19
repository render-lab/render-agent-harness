# AGENTS.md

Repo-specific guidance for AI coding agents (Claude Code, Cursor, Codex, etc.). This file complements `CLAUDE.md` (which captures repo shape, commands, and architecture) by documenting gotchas you cannot infer from a quick directory listing.

Read this whenever a task touches versioning, publishing, scaffolding, snapshots, or capability packs.

## The wizard is private (deployed-from-repo, not published to npm)

`apps/wizard` is `"private": true`. It lives under `apps/` (not `packages/`) because it's a deployable application, not a library — nothing imports it. It's still a workspace package — `core`, `registry`, and `create-render-agent` are wired in via `workspace:*` and tsup builds it into `dist/main.js` — but `pnpm release` / `scripts/publish-unpublished.mjs` walk only `packages/*` and `packages/capabilities/*`, so the wizard is invisible to publishing by both placement and `private: true`. Changesets' publish step does the same. The wizard ships to production via `git push` to the Render service that runs `https://wizard.render-harness.example` (and any self-hosters); npm has no role in that path.

Practical consequences for anything in this file that still mentions `wizard`:

- It does **not** need to appear in coordinated minor changesets. Nothing imports `@render-harness/wizard`, no `harnessVersion` range is checked against it, so its version drifting one minor behind the family is invisible.
- Its `"version"` field still moves (Changesets bumps private packages on `version-packages` like any other), but only the local repo cares.
- The historical incidents below where wizard appears alongside `web` / `create-render-agent` were partial-minor publish failures. Today the same failure mode would only involve `web` and `create-render-agent`; wizard is effectively a deployable app.
- Do not flip wizard back to `private: false` without re-reading the rationale at the bottom of this file's history — the operator-UI feature work routinely touches wizard alongside `web` and `ui`, and re-publishing it puts the May 2026 partial-minor footgun back on the table.

## Versioning model: independent within a minor line, coordinated across minor bumps

The published `@render-harness/*` family does **not** patch in lockstep, but every package **must** stay on the same `0.<minor>.x` line. Different packages live on slightly different patch tracks for deliberate reasons:

- **Core (`core`, `contracts`, `registry`, `runtime-*`)** — bump together when the shared substrate changes.
- **Dependents (`web`, `create-render-agent`)** — cascade-bumped at PATCH (per Changesets' `updateInternalDependencies: "patch"` policy) whenever their internal harness deps change inside the same minor line. They will always be one patch ahead of `core` after a routine patch cut. For coordinated minor cuts they must be listed explicitly in the changeset alongside the rest of the family — see "Minor bumps must be coordinated across the whole family" below for why.
- **UI (`ui`)** — has its own line because the SPA bundle changes independently of the harness substrate.
- **Capabilities (`packages/capabilities/cap-*`)** — patch-independent. Bump only when the capability itself changes; they ship their own patch deltas.
- **Wizard (`wizard`)** — private; see "The wizard is private" above. Not subject to any of the coordination rules below; cascade-patch on it is fine because it has no consumers.

`@render-harness/registry`'s `buildHarnessVersionInfo` enforces this: it walks every running `@render-harness/*` package (including capability packs declared in the consumer's `render-harness.yaml`) and validates each version against the declared `harnessVersion` range. Patch-level drift inside the range is fine — minor drift across siblings is **not** and trips the "Harness version needs attention" red banner in the deployed harness's Config tab. **Do not add a "strict uniqueness" check back in** beyond the existing per-package range check.

The Changesets config (`.changeset/config.json`) keeps `linked: []` empty on purpose. Linking already-drifted packages forces Changesets into a major-version reconciliation (every package jumps to the next `1.0.0`), which is never what we want.

### Minor bumps must be coordinated across the whole family

In semver-zero, `^0.X.Y` does **not** span the `0.X → 0.(X+1)` boundary. So the moment any one `@render-harness/*` package crosses a minor, the runtime version check fails for every consumer whose `harnessVersion` range still anchors at the old minor. There is no scaffolded range short of a multi-clause `>=0.2.0 <0.4.0` that satisfies a partial minor cut, and no scaffolder ever writes one.

**Rule:** a minor bump on any one published first-party harness package (core, contracts, registry, runtime-\*, web, ui, **and every capability pack**) requires a single Changeset that bumps **every** published first-party harness package to the same `0.(X+1).0` baseline. `wizard` is private and intentionally excluded — see "The wizard is private" above.

How to do it:

1. One changeset file in `.changeset/` with a `minor` bump line for **every** published first-party package, including `web` and `create-render-agent`. Use the script:

 ```sh
 for pkg in core contracts registry runtime-cron runtime-web runtime-worker runtime-workflows ui web \
 $(ls packages/capabilities); do
 echo "\"@render-harness/$pkg\": minor"
 done
 echo "\"create-render-agent\": minor"
 ```

 **Do not** rely on cascade-patch for `web` / `create-render-agent`. Changesets cascade-patches from each package's **current** version, not into the family's new minor line — so `web@0.(X-1).0 + cascade-patch = 0.(X-1).1`, **not** `0.X.1`. Leaving them off the changeset produces a partial-minor cut where the runtime harness version check turns red for every deployed harness (no single `harnessVersion` range satisfies both `web@0.(X-1).1` and `core@0.X.0`). The May 2026 partial-minor incident and the May 2026 0.3 → 0.4 cut both reproduced this exact bug; see "Things that bit us recently" below.

 Sanity-check with `pnpm changeset status` before consuming: every first-party package should appear under "minor", the patch and major buckets should be empty (or contain only legitimately separate concurrent patches).

2. `pnpm version-packages` to consume the changeset and bump everyone.
3. Commit + push. CI's `changesets/action` runs the publish step with no remaining changesets and publishes the whole family in one go.
4. Each managed harness then needs `harnessVersion: "^0.(X+1).0"` in `render-harness.yaml` and `"@render-harness/<name>": "^0.(X+1).0"` for every first-party dep in `package.json`. The scaffolder writes these automatically for *new* harnesses (per-package ranges from the rebuilt `bundled-gallery/harness-version.json`), but **existing managed harnesses need a manual bump**.

Until the wizard's `POST /api/agents/add` / `POST /api/capabilities/install` / `PATCH /api/agents/:slug/model` paths grow auto-bump-the-deps logic, every coordinated minor cut leaves a follow-up chore for every existing deployment. Plan accordingly. (The wizard itself is private and not part of the cut, but managed harnesses created *via* the wizard still need their `@render-harness/*` deps re-pointed.)

## Realigning a drifted package

When a package drifts onto its own minor line (e.g. `ui@0.1.x` while the family is on `0.2.x`):

1. Manually edit the package's `version` in `package.json`.
2. Prepend a `## <new-version>` entry to its `CHANGELOG.md` explaining the realignment.
3. Run `pnpm install --lockfile-only`.
4. Commit + push as a normal `chore(<pkg>): realign to X.Y.Z` change.

Do **not** use a Changesets minor bump for realignment alone — Changesets treats the `0.x → 0.(x+1)` crossing as breaking for any cross-package dep, which can cascade unintended bumps onto dependents.

This is what was done for `@render-harness/ui@0.1.5 → 0.2.0`, the six `0.1.x` capability packs, and `@render-harness/web` / `@render-harness/wizard` / `create-render-agent` from `0.3.1 → 0.4.0` after the 0.3 → 0.4 partial-minor incident.

`pnpm changeset status` will fail locally with "Some packages have been changed but no changesets were found" — that's expected and **not a blocker**. The release workflow uses `changesets/action@v1`; when no changesets are pending, the action skips the version step and runs `pnpm release` directly, which delegates to `scripts/publish-unpublished.mjs`. That script walks every package, asks `npm view <name>@<version>` whether the exact version exists, and publishes anything new. Manual `package.json` edits land via exactly that path.

### Why coordinated minor cuts use Changesets cleanly today

Earlier in the project, `@render-harness/web` declared `@render-harness/ui` as an (optional) **peerDependency**. Peer-dep semantics force a MAJOR bump on the consumer when the peer's range moves out of band (a real semver rule, not a Changesets quirk), and in semver-zero **any** minor counts as out-of-band. Net effect: every coordinated minor cut cascaded `@render-harness/web` to `1.0.0`, which is never what we want, so the `0.2 → 0.3` cut had to be done by manual `package.json` edits to dodge Changesets entirely (see commit `420c904`).

`@render-harness/web` never imported `@render-harness/ui` statically — it uses a dynamic `await import("@render-harness/ui")` inside `wrapWithUiSessionIfAvailable` / `mountUiIfAvailable`, with a try/catch that logs `"ui: failed to load @render-harness/ui — install the package or set ui: false"` if the module is missing. The peer declaration was advisory and contributed nothing the dynamic import did not already handle. It was removed in the `0.3 → 0.4` cut so coordinated minors can run through Changesets normally. Do not re-add a peerDependency on `@render-harness/ui` (or any other first-party package) without also re-evaluating this section — it brings the footgun back instantly.

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
| Bug fix in `core`/`registry`/runtime/contracts/ui | Changeset `patch` on the affected package. Dependents (`web`, `wizard`, `create-render-agent`) cascade-bump automatically; only `web` and `create-render-agent` actually publish. |
| Bug fix in a capability pack | Changeset `patch` on just that capability. |
| Wizard-only change (Hono routes, SPA, scaffolder UX) | Changeset `patch` on `@render-harness/wizard` if you want to track the version, or none at all (it's private and never publishes). The `pnpm release` step skips it. |
| New public API in any published first-party package (`core`, `contracts`, `registry`, `runtime-*`, `web`, `ui`, **cap-\***) | **Coordinated minor cut.** One changeset, `minor` on every published first-party harness package — see "Minor bumps must be coordinated across the whole family" above. Never partial. |
| Realign a drifted package onto the family version | Direct `package.json` + `CHANGELOG.md` edit. No changeset. (See "Realigning a drifted package" above.) |
| Catalog metadata change for an existing capability | Edit `capability-catalog/index.yaml`. No version bump needed unless the cap's code also changes. |

## Things that bit us recently (and how to avoid them)

- **Scaffolded projects requesting `^0.1.1` when published is `0.2.x`** — the prebuild script now derives version ranges from the live workspace. If you change how `version-ranges.ts` resolves the default, keep the bundled `harness-version.json` and `capability-catalog.json` as fallback sources.
- **Scaffolded `package.json` requesting `@render-harness/core@^0.2.2` when only `0.2.1` is published** — the scaffolder used to stamp one universal range (from `@render-harness/registry`) across every `@render-harness/*` dep, which broke whenever sibling packages drifted onto different patch tracks (registry cascades ahead of core/contracts/runtime-* on small patches). The bundle now writes per-package ranges into `bundled-gallery/harness-version.json` (`packages: { "@render-harness/core": "^0.2.1", "@render-harness/registry": "^0.2.2", … }`) and `package-json.ts` looks each one up via `harnessVersionRangeFor(pkgName)`. The `harnessVersion` field in scaffolded `render-harness.yaml` is anchored to `@render-harness/core` so the runtime mixed-version check stays satisfied across expected drift.
- **`agent: support-bot` carried over from a gallery template into a user-named project** — `buildHarnessConfig` rewrites `config.agent` to the scaffolded agent name. If you add another field that should be retargeted on copy-from-template, extend `retargetCapabilityConfig`.
- **`UI_COOKIE_SECRET=""` crashing the UI** — `packages/ui/src/auth.ts` treats empty as unset and falls back to a per-process ephemeral. Don't reintroduce a hard fail on missing/empty secrets in development.
- **Partial minor bump (`web@0.3.0` and `wizard@0.3.0` while everything else stayed on `0.2.x`)** — published in May 2026 to add `GET /agents/catalog`. Broke every existing managed harness's runtime version check because no single `harnessVersion` semver range satisfies both `0.2.x` and `0.3.x`. Resolved with a follow-up coordinated `0.3.0` cut across the whole family, but the right answer was always one coordinated minor from the start — see "Minor bumps must be coordinated across the whole family" above.
- **Operator UI modal stuck on "Loading catalog…" forever** — same partial-minor cut as above. New `@render-harness/ui` shipped `fetchAgentCatalog()` hitting same-origin `/agents/catalog`; old `@render-harness/web` had no such route, so Hono's SPA catch-all returned a 303 to `/login` with HTML, and `request<T>()` in `packages/ui/web/src/api.ts` silently typed the HTML string as `AgentCatalogResp`. `request<T>()` now throws on 2xx-with-non-JSON-body so this kind of mismatch surfaces as an actionable error instead of a hung loading state.
- **Coordinated minor cuts cascading `@render-harness/web` to `1.0.0`** — `web` used to declare `@render-harness/ui` as an optional peerDependency. Peer-dep semantics force a MAJOR bump on the consumer when the peer's range moves out of band (in semver-zero, any minor counts), so `pnpm changeset status` reported web at MAJOR for every family-wide minor cut. The 0.2 → 0.3 cut dodged this with manual `package.json` edits (commit `420c904`), but the real fix is that web has never actually imported ui statically — it dynamic-imports `@render-harness/ui` inside `wrapWithUiSessionIfAvailable` / `mountUiIfAvailable` and logs an actionable error if the module is missing. The peerDependency was removed in the 0.3 → 0.4 cut; consumers that want the operator UI install `@render-harness/ui` explicitly alongside `@render-harness/web`. Do not re-add a peerDependency on `@render-harness/ui` (or any other first-party package) — it brings the cascade-to-major footgun straight back.
- **cap-slack name lookups failed with `missing_scope` for bots that had `channels:read` but not `groups:read`** — the resolver's `ensureChannelsIndex` called `client.conversations.list({ types: "public_channel,private_channel" })` as a single request. Slack returns `missing_scope: groups:read` for the *whole* call when any of the requested types is out of scope, even if the caller only cares about the in-scope ones. Net effect: an operator with the documented `channels:read` scope still saw `Slack missing_scope` on every `#channel-name` lookup, and the only escape hatch was to grant `groups:read` they didn't need. Fixed by listing each channel kind in a separate `conversations.list` call and aggregating with `Promise.allSettled`; the resolver also threw away the generic Slack error message — the new `formatSlackError` rewrites `missing_scope` into `Slack missing_scope: 'X' needed (bot currently has: 'Y'). Add 'X' to the bot's OAuth scopes in the Slack app config (api.slack.com → OAuth & Permissions → Bot Token Scopes), reinstall the app to the workspace, and redeploy.` plus hints for `not_in_channel`, `channel_not_found`, `invalid_auth`, `token_revoked`. Regression tests in `packages/capabilities/cap-slack/src/tools.test.ts` pin the "public_channel succeeds, private_channel fails (ignored)" case as well as the "ALL kinds fail → actionable scope error" case.
- **Operator UI's Connections tab errored "server returned non-JSON for /connections" on harnesses with no OAuth packs** — `serveWeb`'s `mountConnectionsRoutes` had an early-return that skipped mounting the routes entirely when `listRegisteredOAuthProviders()` was empty, even though the doc comment one line above promised the opposite. With the routes unmounted, `GET /connections` fell through to the SPA catch-all and returned HTML, which `request<T>()` correctly refused to type as JSON (good defensive helper, terrible UX for anyone who hadn't installed `cap-google` or similar). Fixed by removing the gate so the routes mount unconditionally — `GET /connections` returns a clean `{ providers: [], connections: [] }` for harnesses that don't use the connection API, and the tab renders an empty state. Add a regression assertion in `packages/web/src/routes/connections.integration.test.ts` ("GET /connections (empty registry)") before touching the mount gate again.
- **Coordinated 0.3 → 0.4 cut shipped `web@0.3.1` / `wizard@0.3.1` / `create-render-agent@0.3.1` instead of `0.4.0`** — second partial-minor cut in the project's history, caused by trusting an outdated line in this file that said "web and wizard cascade-patch automatically — they'll go to `0.(X+1).1`". They don't. Changesets cascade-patches from each package's **current** version (`0.3.0 + patch = 0.3.1`), not from the new family minor (`0.4.0 + patch = 0.4.1`). The result was the exact same red-banner failure mode as the May 2026 partial-minor incident — no single `harnessVersion` semver range satisfies both `web@0.3.1` and `core@0.4.0`. Resolved by realigning the three packages to `0.4.0` per "Realigning a drifted package" and rewriting the "Minor bumps must be coordinated across the whole family" procedure to require explicit `minor` entries for `web`, `wizard`, and `create-render-agent` in every coordinated cut. If you see "cascade-patch" used as shorthand for "snaps onto the new minor", that's the bug — say so out loud in the PR description and add a TODO to fix this section.
- **Pack-level migration runner added in the coordinated 0.6.0 cut** — until 0.6, capability packs that needed Postgres tables (cap-memory-pg's lazy bootstrap, or future packs with non-trivial schema) had no boot-time hook; they either ran SQL lazily on first tool call (cap-memory-pg) or required the operator to apply migrations by hand. The new `migrations?: (ctx) => MigrationFile[]` slot on `CapabilityPack` is collected by `defineFromConfig`, surfaced on `AgentDefinition.packMigrations`, and applied by `applyMigrations(pool, { packMigrations })` after core migrations and under the same advisory lock. Each pack migration runs in its own transaction with `(packName, id)` recorded in `agent_pack_migrations` (new core table). The single-arg `applyMigrations(pool)` call site stays backward-compatible. Runtime adapters (cron/web/worker/workflows/web) all pass `agent.packMigrations` now; scaffolded entries do the same. **Convention for pack authors:** write idempotent SQL (`CREATE TABLE IF NOT EXISTS`); the tracking table is belt-and-suspenders. Treat already-published migration ids as immutable — add a new `0002_*` to ALTER, never edit an old SQL in place. See `docs-site/src/content/docs/authoring-capability-packs.mdx#migrations` for the full walkthrough.
