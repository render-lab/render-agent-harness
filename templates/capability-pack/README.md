# Example Capability Pack

This is a starter for community-authored Render agent harness capability packs.

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm validate
```

## Publish

Update `package.json`:

- Set `name` to your npm package, such as `@your-scope/cap-example`.
- Keep the `render-harness-cap` keyword.
- Keep `"type": "module"` and an ESM `exports` entry.
- Fill in `renderHarness.gallery` so the capability catalog can display the pack.

Then publish with:

```sh
pnpm publish --access public
```

Installing a capability pack runs its code in the host app process. Treat pack dependencies and provider SDKs with the same care as any production npm dependency.
