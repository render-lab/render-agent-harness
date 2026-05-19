# Gallery v1: in-monorepo curated agents + capabilities

## Context

Phase 2 of the onboarding direction in [`onboarding-plan.md`](./onboarding-plan.md). Phase 1 — the CLI scaffolder, [`cli-scaffolder-plan.md`](./cli-scaffolder-plan.md) — shipped and replaces the manual `cp -r templates/render-harness-entry` flow with `npx create-render-agent`. Today it emits **blank** projects only. Phase 2 makes the CLI (and the eventual UI scaffolder, Phase 3) able to **start from a gallery entry**: a curated agent template or capability pack with pre-filled manifest values and code stubs.

Three decisions locked in conversation before this plan:

- **Multi-runtime fan-out is the default.** Gallery entries declare ≥1 runtimes; the CLI passes those through into the generated project unchanged.
- **In-monorepo gallery for now.** Entries live under a new top-level `gallery/` folder. A future move to a sibling `render-harness-gallery` repo (matching the existing `IndexSchema` in [`packages/registry/src/schema.ts`](../packages/registry/src/schema.ts) which is already designed for a remote index) is explicit out-of-scope for v1 but unblocked by the schema choices here.
- **Agents and capabilities are both first-class shareable units**, surfaced through one gallery surface (with filtering), per locked direction §1.3 in `onboarding-plan.md`.

This plan is the index schema, the directory layout, the CLI integration, and the snapshotting story. The eventual website / UI gallery presentation is Phase 3 work and is not in scope here.

## Dependencies

- **CLI scaffolder (shipped).** The wizard at `packages/create-render-agent/src/prompts.ts` becomes the consumer. Today it hardcodes `KNOWN_CAPABILITIES` and offers no template-selection prompt at all — both replaced by gallery-driven options.
- **Existing schemas in [`packages/registry/src/schema.ts`](../packages/registry/src/schema.ts).** `HarnessConfigSchema` (the agent manifest) and `IndexEntrySchema` / `IndexSchema` (designed for the future external index repo) are the reference shapes. The new gallery index extends rather than replaces them.
- **Existing capability packs in [`packages/capabilities/*`](../packages/capabilities/).** All six packs already carry a `render-harness-cap` keyword + description in their `package.json` — this is the existing discovery convention and v1 of the gallery reuses it directly.

Nothing else blocks this work.

## Architecture

### 3.1 Top-level `gallery/` layout

```
gallery/
├── index.yaml                    # the single source-of-truth catalog
├── README.md                     # how to contribute an entry
└── agents/
    ├── support-bot/
    │   ├── render-harness.yaml   # the manifest this entry seeds
    │   ├── system-prompt.md      # extracted prompt (referenced from the yaml)
    │   └── README.md             # blurb shown in the wizard preview
    ├── research-cron/
    │   └── ...
    └── ...
```

Capability gallery entries are **not** duplicated under `gallery/`. They are auto-discovered from `packages/capabilities/*/package.json` by reading the `render-harness-cap` keyword, the `name`, the `description`, and a new optional `renderHarness.gallery` block in each pack's `package.json` (see §3.4). This means a contributor adding a capability adds it to one place — `packages/capabilities/` — not two.

### 3.2 `gallery/index.yaml` schema

A new schema in `packages/registry/src/gallery.ts` (exported from the registry package via a new `./gallery` subpath). Shape:

```yaml
schemaVersion: 1
agents:
  - slug: support-bot
    name: "Support bot"
    description: "Slack-driven first-line support agent with Linear escalation."
    path: ./agents/support-bot          # relative to gallery/
    categories: ["support", "slack"]
    runtimeKinds: ["web", "worker"]      # mirrored from the entry's render-harness.yaml
    capabilities: ["@render-harness/cap-search-exa"]
    author: "render-harness"
  - slug: research-cron
    ...
```

The CLI consumes `runtimeKinds`, `capabilities`, and `path` to seed the wizard. The schema is small intentionally — the full agent shape is in each entry's `render-harness.yaml`, validated against `HarnessConfigSchema` at load time.

Zod schemas:

- `GalleryAgentEntrySchema` — fields above. `path` validated as a relative POSIX path.
- `GalleryIndexSchema = { schemaVersion: 1, agents: GalleryAgentEntrySchema[] }`.

Capability entries are not in `index.yaml` — they're derived from the capabilities workspace at load time, see §3.4.

### 3.3 Loader: `loadGallery({ root })`

New module `packages/registry/src/gallery.ts` exports `loadGallery({ root })` which returns:

```ts
interface Gallery {
  agents: GalleryAgentEntry[];        // from gallery/index.yaml
  capabilities: GalleryCapabilityEntry[];  // from packages/capabilities/*/package.json
}

interface GalleryAgentEntry {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  runtimeKinds: RuntimeKind[];
  capabilities: string[];
  /** Resolved absolute path to the entry directory, ready to read files from. */
  absPath: string;
  /** Pre-parsed render-harness.yaml for the entry (HarnessConfig). */
  manifest: HarnessConfig;
  /** README markdown to show as preview, or null. */
  readme: string | null;
}

interface GalleryCapabilityEntry {
  pack: string;               // npm package name, e.g. "@render-harness/cap-search-exa"
  description: string;        // from package.json description
  envHint: string | null;     // from new renderHarness.gallery.envHint field, optional
  label: string;              // from renderHarness.gallery.label or derived from pack name
}
```

The loader:

1. Reads `<root>/gallery/index.yaml` and validates via `GalleryIndexSchema.parse`.
2. For each agent entry, reads `<absPath>/render-harness.yaml` and parses through the existing `HarnessConfigSchema`. Schema errors abort loading the gallery (loud, not silent).
3. Walks `packages/capabilities/*/package.json`. Skips packages whose keywords don't contain `render-harness-cap`. Reads `name`, `description`, and the optional `renderHarness.gallery` block.

`root` defaults to the harness repo root when run from the workspace; the CLI passes a different `root` pointing at its bundled snapshot (see §3.5).

### 3.4 Capability metadata: `renderHarness.gallery` in `package.json`

A new optional block added to each capability pack's `package.json`. Example for `cap-search-exa`:

```json
{
  "renderHarness": {
    "gallery": {
      "label": "Exa web search",
      "envHint": "EXA_API_KEY"
    }
  }
}
```

If absent, `label` is derived from the pack name (`cap-search-exa` → `Exa search`) and `envHint` is `null`. This keeps existing packs working without touching them, but lets future packs polish their gallery presentation. Adding the block to the six existing packs is a small follow-up commit, not gating.

### 3.5 Bundling the gallery into the CLI

The CLI package (`packages/create-render-agent`) ships a snapshot of the gallery in its npm tarball so `npx create-render-agent` works without cloning the harness repo. Mechanism:

- A new pre-build step `scripts/bundle-gallery.ts` (run before `tsup`) copies `gallery/` and the capability packages' relevant `package.json` slices into `packages/create-render-agent/bundled-gallery/`.
- `tsup.config.ts` is extended so `bundled-gallery/` is included in the published `files` allowlist.
- At runtime, the CLI's bin computes the bundled path as `new URL("../bundled-gallery", import.meta.url)` and passes it to `loadGallery({ root })`.
- A `--gallery <path>` flag lets contributors point at a live gallery for local development without rebuilding.

The published gallery snapshot is the version that was current at CLI publish time. Drift between CLI and gallery is acceptable because:
- Schema is versioned (`schemaVersion: 1`).
- Each gallery entry pins to the manifest shape that was current at publish.
- Users who want the latest gallery can `npm i -g create-render-agent@latest` or pass `--gallery` at a checkout of the harness repo.

### 3.6 CLI wizard changes

Today's wizard order (per `packages/create-render-agent/src/prompts.ts`):

1. Directory → 2. Agent name → 3. Description → 4. System prompt → 5. Model → 6. Runtimes → 7. UI? → 8. Capabilities → 9. git init → 10. install deps

After Phase 2:

0. **Start from a gallery agent, or blank?** (new — multi-row select with previews from `gallery/index.yaml`)
   - "Blank — fill everything in" (current behaviour)
   - One row per `gallery/index.yaml` agent entry (label + 1-line description)
1. Directory → 2. Agent name (default = gallery slug if a template was picked, else from directory) → 3–6 (description/prompt/model/runtimes default from the gallery entry's `render-harness.yaml` but stay editable) → 7. UI? (existing) → 8. Capabilities (still multi-select; **list now comes from gallery capabilities**; pre-selected = the template's `capabilities`) → 9. git init → 10. install deps.

The `KNOWN_CAPABILITIES` hardcoded array is deleted and replaced by `gallery.capabilities` from the loader. The `KNOWN_MODELS` array stays hardcoded — model availability is a Claude-API concern, not a gallery one.

When the user picks a gallery agent, the generator copies the entry's `render-harness.yaml` as the base and overrides only the fields the wizard collected (name, description, etc.). Code files (`agent/index.ts`, runtime entries) still come from the existing programmatic templates so multi-runtime selection differing from the gallery's default still works.

## 4. File-by-file changes

### New files

- `gallery/index.yaml` — initial catalog with 2–3 seed agent entries.
- `gallery/README.md` — contributor guide for adding entries.
- `gallery/agents/<slug>/render-harness.yaml` — one per seed entry (start with: a chat agent, a Slack-style support agent, a research cron).
- `gallery/agents/<slug>/system-prompt.md` — full prompts pulled out of yaml for readability (the yaml references them or inlines them; choice deferred to implementation).
- `gallery/agents/<slug>/README.md` — wizard preview.
- `packages/registry/src/gallery.ts` — schemas + `loadGallery({ root })`.
- `packages/registry/src/gallery.test.ts` — vitest unit tests for schema + loader against `gallery/` fixtures.
- `packages/create-render-agent/scripts/bundle-gallery.ts` — pre-build snapshotter.
- `packages/create-render-agent/src/gallery.ts` — thin wrapper that resolves the bundled or `--gallery`-flagged root and calls `loadGallery`.

### Modified files

- `packages/registry/package.json` — add `./gallery` subpath export.
- `packages/registry/tsup.config.ts` — add `gallery: "src/gallery.ts"` entry.
- `packages/create-render-agent/package.json` — add a `prebuild` script invoking `bundle-gallery.ts`, add `bundled-gallery` to `files`.
- `packages/create-render-agent/src/prompts.ts` — delete `KNOWN_CAPABILITIES`, accept the loaded gallery, add the "start from template" prompt, populate capability list from gallery.
- `packages/create-render-agent/src/generate.ts` — if a gallery entry is selected, merge its manifest into the answers before emitting files.
- `packages/create-render-agent/src/bin.ts` — parse `--gallery <path>` flag, load the gallery, pass to `runWizard`.
- Optionally: `packages/capabilities/*/package.json` — add the `renderHarness.gallery` block for the six existing packs (separate small commit; not gating).

### Files explicitly not changed

- `HarnessConfigSchema` — the agent manifest is unchanged. Gallery metadata is in a new schema, not bolted onto the manifest.
- `IndexSchema` / `IndexEntrySchema` — the external-registry concept stays as-is for a future Phase 2.5 (federated remote index).
- `templates/render-harness-entry/` — still the "blank" starter the wizard falls back to.

## 5. Reused existing primitives

- `HarnessConfigSchema` from `packages/registry/src/schema.ts` for validating every gallery entry's `render-harness.yaml`.
- The `render-harness-cap` keyword convention already present on every pack's `package.json`.
- The CLI scaffolder's template modules in `packages/create-render-agent/src/templates/` — gallery selection only changes default values, not the file-emission code paths.
- The `yaml` package, already a dep of `@render-harness/registry`.

## 6. Out of scope for v1

Explicitly deferred:

1. **External / federated gallery.** The existing `IndexSchema` in the registry was designed for a sibling `render-harness-gallery` repo; v1 stays local. Adding that backend is Phase 2.5 once the schema stabilizes.
2. **Gallery website / UI surface.** No new HTTP routes, no new pages on `render.com`. Wizard previews are CLI-only.
3. **Versioning of gallery entries.** v1 entries do not carry a `version` field; entries are always "current monorepo state at CLI publish time."
4. **Forking-as-a-feature.** The CLI seeds a fresh project from a gallery entry but does not maintain a link back to the source — no "diff against template" or "pull upstream changes" flows. The user owns the generated code from minute one.
5. **Search / categories beyond a free-form `categories[]` array.** The wizard's gallery selector is a flat list with descriptions; real filtering can come when the count exceeds ~20 entries.
6. **Capability-pack metadata sync.** The `renderHarness.gallery` block on each capability is optional in v1; backfilling it to the six existing packs is a separate small commit, not blocking.

## 7. Verification

### Unit / schema

```sh
pnpm --filter @render-harness/registry test
```

- `gallery.test.ts` parses `gallery/index.yaml` against `GalleryIndexSchema`.
- For each entry in the index, loads `<path>/render-harness.yaml` and asserts it parses against `HarnessConfigSchema`.
- Asserts every entry's declared `runtimeKinds` matches the kinds present in its manifest's `runtimes[]` (no drift).
- Asserts capability-pack discovery picks up all six existing packs.

### CLI integration

```sh
pnpm --filter create-render-agent test
```

- Snapshot test for the "blank" path stays unchanged (regression guard).
- New snapshot test for "start from `support-bot` template" → verifies the emitted `render-harness.yaml` matches the gallery entry's values, except for fields the wizard overrode (name, description, optionally license).
- A test invokes the bundled-gallery loader against the in-repo `gallery/` and confirms entries load without error.

### Manual UX

- `node packages/create-render-agent/dist/bin.js --gallery ./gallery my-agent` runs the wizard with the live in-repo gallery and produces a project that boots locally via `pnpm db:up && pnpm dev`.
- Without `--gallery`, the CLI uses its bundled snapshot.

## 8. Execution order

Numbered for incremental commits / PRs:

1. **Schema** — write `packages/registry/src/gallery.ts` (`GalleryAgentEntrySchema`, `GalleryIndexSchema`, `loadGallery`). Unit-tested against fixture files in a new `packages/registry/test/fixtures/gallery/`. No consumers yet.
2. **Seed gallery** — create `gallery/index.yaml` and 2–3 agent entries (chat, support-style, research-cron). Wire the loader to read from the real `gallery/` and add a top-level test that asserts every entry parses cleanly.
3. **Bundling pre-build** — `packages/create-render-agent/scripts/bundle-gallery.ts` snapshots `gallery/` into `bundled-gallery/`. CI passes; no behaviour change in the CLI yet.
4. **CLI wiring** — `prompts.ts` gains the "start from template" prompt; `KNOWN_CAPABILITIES` is replaced by gallery-loaded entries; `generate.ts` merges template defaults. New snapshot tests.
5. **Capability metadata backfill** (small follow-up commit, not gating) — add `renderHarness.gallery` to each `packages/capabilities/*/package.json` for nicer labels.
6. **Docs** — `gallery/README.md` (contributor guide) + a section in `docs/registry-guide.md` linking out from the existing author guide.

Each step is independently mergeable. After step 4 the wizard is end-to-end usable on top of the in-monorepo gallery; steps 5–6 are polish.

## 9. Bundles addendum (shipped after Phase 4)

The gallery now distinguishes two entry kinds — see [`bundles-plan.md`](./bundles-plan.md) for the design and [`bundle-authoring.md`](./bundle-authoring.md) for the contributor guide.

- **`kind: "agent"`** — single-agent template. The wizard collects per-agent prompts (name, system prompt, model, runtimes, capabilities) seeded from the entry's manifest, then `buildFileMap` emits the templated project. Today's three entries (`chat`, `support-bot`, `research-cron`) all fall into this bucket.
- **`kind: "bundle"`** — sealed multi-agent template. The wizard short-circuits the per-agent steps. `buildFileMap` materializes the bundle's manifest + `src/*.ts` source files verbatim and generates V2-aware runtime entrypoints (`src/web.ts`, `src/worker.ts`, `src/cron.ts`). The first bundle is `chief-of-staff`.

The `kind` is *derived* from the manifest at load time (single agent whose id matches the bundle name → `agent`; otherwise → `bundle`), not declared in `index.yaml`. The cross-check at [`packages/registry/src/gallery.ts:186-196`](../packages/registry/src/gallery.ts) uses `flattenRuntimeKinds` to union runtime kinds across all agents in the manifest.

`ResolvedAgentEntry` gained two fields to support bundles:

- `kind: "agent" | "bundle"`
- `sourceFiles: Record<string, string>` — populated for bundles (empty for single-agent entries)

Both the CLI (`packages/create-render-agent/src/prompts.ts:runBundleWizard`) and the browser wizard (`apps/wizard/web/src/steps/BundleReview.tsx`) detect bundle entries on the Template step and route to a sealed-bundle review screen instead of the per-agent wizard.
