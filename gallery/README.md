# gallery/

Curated agent templates the CLI (`npx create-render-agent`) and the future UI scaffolder offer as starting points. Capabilities (`@render-harness/cap-*`) are not listed here — they're auto-discovered from `packages/capabilities/*` via the `render-harness-cap` keyword in each pack's `package.json`.

See [`docs/gallery-plan.md`](../docs/gallery-plan.md) for the design rationale.

## Adding an entry

1. Create `gallery/agents/<slug>/` with a `render-harness.yaml` (must parse against `HarnessConfigSchema` in `packages/registry/src/schema.ts`).
2. (Recommended) Add `gallery/agents/<slug>/README.md` — the wizard shows it as a preview.
3. Add a row to [`index.yaml`](./index.yaml). The `runtimeKinds` field must match the manifest's `runtimes[].kind` — the loader cross-checks and the registry test will fail loudly if they drift.
4. Run `pnpm --filter @render-harness/registry test` to confirm the entry parses.
5. Run `pnpm --filter create-render-agent build` so the CLI bundles your new entry.

## Constraints v1

- Local-monorepo only. No remote/federated gallery yet (see `docs/onboarding-plan.md` §5 open question 2).
- No `version` field on entries — entries always reflect their state at the snapshot time of the bundled CLI.
- Manifests reference capability packs by npm name. The pack itself lives under `packages/capabilities/`, not under `gallery/`.

## Layout

```
gallery/
├── index.yaml                            # the catalog
├── README.md                             # this file
└── agents/
    └── <slug>/
        ├── render-harness.yaml           # validated against HarnessConfigSchema
        └── README.md                     # wizard preview (optional but encouraged)
```
