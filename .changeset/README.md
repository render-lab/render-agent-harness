# Changesets

Use Changesets to bump and publish first-party harness packages together.

Create a changeset for every user-facing package change:

```sh
pnpm changeset
```

Choose the highest required semver bump across the affected first-party packages:

- `patch`: fixes, docs, tests, and internal refactors.
- `minor`: additive public APIs, config fields, routes, tools, runtime features, or capability hooks.
- `major`: breaking API, config, database, runtime, or tool contract changes.

The release workflow opens a Version Packages PR. Merge that PR to publish.
