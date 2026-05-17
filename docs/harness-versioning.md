# Harness Versioning Runbook

Use this runbook whenever a change affects first-party harness packages.

## Version Model

First-party `@render-harness/*` packages release together. Do not bump one package in isolation.

Use semver:

- **Patch**: bug fixes, documentation, tests, formatting, internal refactors, and non-breaking UI polish.
- **Minor**: additive public APIs, new config fields, new routes, new runtime behavior, new capability hooks, new built-in tools, or new official capability packs.
- **Major**: breaking changes to `render-harness.yaml`, public runtime APIs, database migrations that need manual action, tool names, tool schemas, package exports, or stable HTTP contracts.

When in doubt, choose the higher bump.

## Author Workflow

1. Make your code changes.
2. Run the relevant verification commands.
3. Add a changeset:

   ```sh
   pnpm changeset
   ```

4. Select the affected first-party packages. For broad harness changes, select all relevant `@render-harness/*` packages.
5. Pick the bump type using the rules above.
6. Commit the generated `.changeset/*.md` file with your PR.

## Release Workflow

The GitHub release workflow does two things:

- On every PR and push to `main`, it runs install, typecheck, tests, and `pnpm check`.
- On pushes to `main`, Changesets either opens a Version Packages PR or publishes after that PR is merged.

The Version Packages PR runs:

```sh
pnpm version-packages
```

That command applies queued changesets and refreshes the lockfile.

After the Version Packages PR is merged, the release job runs:

```sh
pnpm release
```

That command builds first-party packages and publishes them to npm.

## Required Setup

Before the first publish:

- Create the `@render-harness` npm organization.
- Configure either `NPM_TOKEN` or npm trusted publishing for this repository.
- Keep `GITHUB_TOKEN` permissions enabled for release PR creation.

Prefer trusted publishing with provenance. Use `NPM_TOKEN` only if trusted publishing is not available.

## After Publishing

Verify the version family:

```sh
npm view @render-harness/core version
npm view @render-harness/registry version
npm view @render-harness/web version
npm view @render-harness/ui version
```

Then scaffold a clean project without `--harness-root` and confirm install works from npm.

## Operator UI

Deployments expose harness version metadata through `GET /deployment`. The operator UI shows the running harness version in the sidebar and the detailed package list on the Config tab.

Treat `Harness mixed` as a release or install problem. First-party packages should normally report one coherent version.
