## render-harness-index

The decentralized registry index for the [Render agent harness](https://github.com/render-examples/render-harness). One file, [`index.json`](./index.json), listing every public entry by name, description, repo, and pinned commit SHA.

This is scaffolding inside the harness monorepo for v1; the live index will move to its own repo (`render-harness-index`) before publication.

### Adding an entry

1. Push your entry repo to GitHub (or any other public Git host the validator supports).
2. Capture the commit SHA: `git rev-parse HEAD`.
3. Open a PR to this directory adding to `index.json`:

```json
{
  "name": "my-agent",
  "description": "One-line description (max 280 chars).",
  "repo": "https://github.com/<owner>/<repo>",
  "ref": "<40-char commit SHA>",
  "categories": ["ci", "github"]
}
```

4. CI runs both `validate.mjs` (schema-checks the index) and `validate-entries.mjs` (fetches each entry's `render-harness.yaml` at the pinned SHA and validates that). Both must pass before merge.

### Hard rules

- `ref` must be a 40-character lowercase commit SHA. **Tags are rejected** so end users always deploy exactly the entry that was reviewed.
- `name` is unique across the index.
- The entry's repo must contain a `render-harness.yaml` and a committed `render.yaml` at the pinned SHA.

### Validating locally

```sh
pnpm install
pnpm validate            # schema check
pnpm validate:entries    # fetches each pinned entry and validates its YAML
```

Set `GITHUB_TOKEN` to avoid rate limits on the second step when validating many entries.
