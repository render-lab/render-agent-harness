# CLI scaffolder: `npx create-render-agent`

## Context

Phase 1 of the onboarding direction in [`onboarding-plan.md`](./onboarding-plan.md). The goal is to replace the manual `cp -r path/to/render-harness/templates/render-harness-entry my-agent` flow currently documented in [`docs/registry-guide.md`](./registry-guide.md) (section "1. Scaffold from the template") with a wizard that asks the right questions and writes a tailored project tree.

The CLI is the lowest-risk surface to build first because:

- It builds on infrastructure that already exists: the `HarnessConfigSchema` in [`packages/registry/src/schema.ts`](../packages/registry/src/schema.ts), the loader `defineFromConfig` in [`packages/registry/src/load-config.ts`](../packages/registry/src/load-config.ts), and the canonical starter at [`templates/render-harness-entry/`](../templates/render-harness-entry/).
- It produces the same artifact (`render-harness.yaml` + agent + runtime entrypoints) that the future UI wizard will produce, so the wizard prompt shape we settle on here gets re-used.
- It does not require new platform infrastructure (gallery hosting, managed-repo bot, UI surface).

This plan is scoped to the CLI alone. Gallery integration (consuming gallery entries as scaffold starting points) lands in Phase 2. The managed-repo + UI scaffolder lands in Phase 3.

## Dependencies

None blocking. The CLI consumes existing schemas/loaders read-only and only writes files into the user's target directory. No coordination with other in-flight work is required.

One decision needs resolving before publishing — the **package name on npm**. The recommendation is `create-render-agent`, which makes both `npm init render-agent` (npm's `create-*` convention) and `npx create-render-agent` work. Alternatives considered: `create-render-harness`, `@render/create-agent`. The unprefixed form is the most discoverable.

## Architecture

### Package layout

New package at `packages/create-render-agent/`, mirroring the existing shape of [`packages/registry/`](../packages/registry/):

```
packages/create-render-agent/
├── package.json            # bin: "create-render-agent", workspace deps on registry
├── tsconfig.json
├── tsup.config.ts          # ESM, target node22, bin entry
├── src/
│   ├── bin.ts              # shebang + CLI entry
│   ├── prompts.ts          # @clack/prompts-driven wizard
│   ├── generate.ts         # answers → file map → write to disk
│   ├── templates/          # programmatic templates (TS modules returning strings)
│   │   ├── render-harness-yaml.ts
│   │   ├── agent-index.ts
│   │   ├── runtime-web.ts
│   │   ├── runtime-cron.ts
│   │   ├── runtime-worker.ts
│   │   ├── package-json.ts
│   │   ├── tsup-config.ts
│   │   ├── tsconfig.ts
│   │   ├── readme.ts
│   │   ├── env-example.ts
│   │   └── gitignore.ts
│   └── validate.ts         # uses HarnessConfigSchema before writing
└── test/
    └── snapshots/          # vitest snapshots per runtime combo
```

`@render-harness/create-render-agent` published to npm with `"bin": { "create-render-agent": "./dist/bin.js" }` and a `files` allowlist of `["dist"]`. Templates are bundled into `dist/` by tsup as imported modules, **not** copied as static template files — this avoids the per-runtime-combination template explosion problem.

### Prompt library

`@clack/prompts` — small, ESM-native, widely adopted by `create-astro`, `create-svelte`, etc. Not currently a dependency anywhere in the monorepo; added only to `packages/create-render-agent/package.json`. Alternative (`prompts`) is smaller but has worse multi-select UX.

### CLI flow

```
$ npx create-render-agent [directory]

◇ Pick a directory          → "my-agent" (positional arg or prompt)
◇ Agent name                → "my-agent" (default from dir)
◇ Description               → free text
◇ System prompt             → multiline editor
◇ Model                     → claude-sonnet-4-6 | claude-opus-4-7 | claude-haiku-4-5 | other
◇ Trigger surfaces          → ☑ web   ☐ cron   ☐ worker   (multi-select, ≥1)
   ├ if cron:   Schedule    → "0 13 * * *" with validation
   └ if worker: Queue name  → "<name>-runs" default
◇ Capabilities (optional)   → multi-select (cap-slack, cap-webhook-generic, …)
◇ License                   → MIT | Apache-2.0 | none
◇ Initialize git?           → yes/no
◇ Install dependencies?     → yes/no  (runs pnpm install)
```

Workflow runtime is **excluded** from v1 because locked decision #8 in [`docs/architecture.md`](./architecture.md) notes workflow services are not supported in `render.yaml` Blueprints yet — they're Dashboard-created. Including it in the wizard would create asymmetry the user has to work around. Add it back when Blueprint support lands.

### Template generation strategy

**Programmatic, not file-based.** Each template module exports a function taking the resolved `Answers` object and returning the file contents as a string. Example:

```ts
// templates/render-harness-yaml.ts
export function renderHarnessYaml(answers: Answers): string {
  // builds the YAML object, validates against HarnessConfigSchema,
  // serialises with `yaml` package (already a dep of @render-harness/registry)
}
```

Why programmatic:

- Avoids the 2^N template-file explosion for runtime combinations (1, 2, 3 runtimes × cron/worker/web mixes).
- Keeps the schema as the single source of truth — the YAML emitter validates against `HarnessConfigSchema` before writing.
- TypeScript catches drift if the schema evolves (the emitter won't compile).

### Validation

Before writing any file, the generated `render-harness.yaml` object is parsed through `HarnessConfigSchema.parse(...)` from `@render-harness/registry/schema`. If parsing fails, the CLI prints the validation error and exits without writing. This guarantees the output is loadable by `defineFromConfig` from the moment it lands on disk.

## Wizard prompt details

| Prompt | Type | Default | Validation |
|---|---|---|---|
| Directory | text (positional or interactive) | `"my-agent"` | Must not exist or must be empty |
| Agent name | text | derived from directory | npm-name regex (lowercase, hyphens) |
| Description | text | empty | none |
| System prompt | multiline | "You are a helpful assistant." | non-empty |
| Model | select | `claude-sonnet-4-6` | one of known IDs |
| Runtimes | multi-select | `["web"]` | at least one selected |
| Cron schedule (conditional) | text | `"0 13 * * *"` | basic 5-field cron regex |
| Worker queue (conditional) | text | `"<name>-runs"` | non-empty, kebab-case |
| Capabilities | multi-select | none | from a known list (see below) |
| License | select | `MIT` | one of MIT, Apache-2.0, none |
| Git init | confirm | yes | — |
| Install deps | confirm | yes | — |

**Capability list in v1** is hardcoded in the CLI. It enumerates capability packs published in the monorepo (look at `packages/capabilities/*` at build time of the CLI). When the gallery lands in Phase 2, this list moves to the gallery index. Open question #6 in `onboarding-plan.md` is referenced but does not block v1 — agents and capabilities can be unified later without breaking the CLI's interface.

## Output trees

### Web only (default)

```
my-agent/
├── .env.example
├── .gitignore
├── README.md
├── agent/index.ts
├── package.json
├── render-harness.yaml
├── src/main.ts
├── tsconfig.json
└── tsup.config.ts
```

Identical to `templates/render-harness-entry/` today.

### Multi-runtime (e.g. web + worker)

```
my-agent/
├── .env.example
├── .gitignore
├── README.md
├── agent/index.ts
├── package.json           # dev:web, dev:worker, start:web, start:worker scripts
├── render-harness.yaml    # runtimes: [{web}, {worker}]
├── src/
│   ├── web.ts             # serveAgent from runtime-web
│   └── worker.ts          # consume from runtime-worker
├── tsconfig.json
└── tsup.config.ts         # entry: { web: "src/web.ts", worker: "src/worker.ts" }
```

Matches the existing shape of [`examples/support-agent/`](../examples/support-agent/).

### Cron + web

Same as multi-runtime above but with `src/cron.ts` (from `runtime-cron`) plus `src/web.ts`. `render-harness.yaml.runtimes[]` carries the cron `schedule` field.

## File-by-file changes

### New files

- `packages/create-render-agent/package.json`
- `packages/create-render-agent/tsconfig.json`
- `packages/create-render-agent/tsup.config.ts`
- `packages/create-render-agent/src/bin.ts` — shebang `#!/usr/bin/env node`, parses argv, calls `runWizard()`
- `packages/create-render-agent/src/prompts.ts` — `runWizard(): Promise<Answers>` using `@clack/prompts`
- `packages/create-render-agent/src/generate.ts` — `generate(answers, targetDir): Promise<void>`; orchestrates template calls, validation, writes
- `packages/create-render-agent/src/validate.ts` — wraps `HarnessConfigSchema.parse`
- `packages/create-render-agent/src/templates/*.ts` — 10 template modules listed in the layout above
- `packages/create-render-agent/test/generate.test.ts` — vitest snapshot tests per runtime combo (web-only, cron-only, worker-only, web+worker, web+cron, web+worker+cron)

### Modified files

- Root `package.json` — add `"create": "pnpm --filter @render-harness/create-render-agent dev --"` script for local testing of the wizard end-to-end during development. No other changes.
- `docs/registry-guide.md` — section "1. Scaffold from the template" rewritten to lead with `npx create-render-agent my-agent`; the `cp -r` flow demoted to "manual alternative" or removed entirely. Done in the same PR as the CLI ships.

### Files explicitly **not** changed

- `templates/render-harness-entry/` stays put. The CLI references its file shape conceptually but does not depend on the directory at runtime (templates are programmatic). The template remains useful as a manual-fork escape hatch and as an in-repo reference for the CLI's output shape.
- `packages/registry/` — no changes. Schema and loader are consumed read-only.
- All `examples/*` — no changes.

## Reused existing primitives

- [`packages/registry/src/schema.ts`](../packages/registry/src/schema.ts) — `HarnessConfigSchema` for validation; `RuntimeKind` enum for the runtime multi-select options.
- [`packages/registry/src/load-config.ts`](../packages/registry/src/load-config.ts) — implicit dependency; the generated project will be loaded through this at deploy time. The CLI does not call `defineFromConfig` itself.
- [`templates/render-harness-entry/`](../templates/render-harness-entry/) — shape reference for the web-only output.
- [`examples/support-agent/`](../examples/support-agent/) — shape reference for multi-runtime output (specifically dual `src/web.ts` + `src/worker.ts`, dual `dev:*`/`start:*` scripts, tsup with multiple entries).
- `yaml` package — already a dependency of `@render-harness/registry`; used here for emitting the generated `render-harness.yaml`.

## Out of scope for v1

These are explicitly deferred to keep Phase 1 shippable. Each is called out so the deferral is intentional rather than oversight:

1. **Gallery starter selection** — "start from a gallery entry vs. blank" is a Phase 2 capability. v1 only supports blank.
2. **Workflow runtime** — excluded until `render.yaml` Blueprints support workflow services (locked decision #8).
3. **`render.yaml` generation** — the CLI emits `render-harness.yaml`, not `render.yaml`. Blueprint generation is a separate concern; deferred until there's a clear story for who owns the Render service shapes.
4. **MCP server prompts** — adding `mcpServers[]` entries via the wizard. Users can hand-edit `render-harness.yaml` post-scaffold; the wizard stays minimal.
5. **Local `docker-compose.yml` for Postgres + Valkey** — out of scope; the generated README points users at the harness repo's `pnpm db:up` flow. Worth revisiting in Phase 1.1 for standalone-project DX.
6. **Telemetry / analytics on wizard usage** — no telemetry in v1.
7. **Update prompts** (`create-render-agent upgrade` to bump harness versions in an existing project) — separate command, separate plan.

## Verification

The CLI is shippable when all of the following pass:

### Unit / snapshot

```sh
pnpm --filter @render-harness/create-render-agent test
```

- Snapshot tests cover all six runtime combinations (web, cron, worker, web+worker, web+cron, web+worker+cron). Each snapshot includes every emitted file.
- A test asserts the generated `render-harness.yaml` parses successfully through `HarnessConfigSchema.parse`.
- A test asserts the generated `package.json` has the right scripts per runtime combo (e.g., `dev:web` + `dev:worker` when both selected).

### Integration

```sh
cd /tmp && rm -rf my-agent
node packages/create-render-agent/dist/bin.js my-agent
   # answer prompts: web only, model claude-sonnet-4-6, license MIT
cd my-agent && pnpm install
ANTHROPIC_API_KEY=... pnpm dev
   # confirm server boots, agent responds to a /messages POST
```

Repeat with web+worker and verify both processes start via `pnpm dev:web` / `pnpm dev:worker`.

### Schema round-trip

The generated `render-harness.yaml` for each runtime combo is loaded through `defineFromConfig` (in a test) and the resulting agent metadata matches expectations (correct runtimes, model, capabilities).

### Manual UX

- Wizard runs to completion without a crash on every default-only path (just hit enter).
- `--help` flag prints usage.
- Existing non-empty target directory is detected and the wizard offers to abort or pick another path.
- `Ctrl+C` mid-wizard exits cleanly (clack handles this).

## Execution order

Numbered for incremental landing — each step is a self-contained commit/PR:

1. Scaffold `packages/create-render-agent/` skeleton (package.json, tsconfig, tsup.config, empty src/, vitest config). PR is a no-op functionally but stakes out the structure.
2. Implement template modules in `src/templates/` plus `validate.ts`. Pure functions, fully unit-tested. No CLI yet.
3. Implement `src/generate.ts` orchestrating the templates and writing to disk. Unit-tested by writing to a temp directory.
4. Implement `src/prompts.ts` with `@clack/prompts`. Manually exercised; not unit-tested (clack mocking is more pain than value at this stage).
5. Wire `src/bin.ts` to argv parsing + `runWizard()` + `generate()`. End-to-end integration test runs the bin against a temp dir.
6. Add snapshot tests for all six runtime combos.
7. Rewrite the "Scaffold from the template" section of `docs/registry-guide.md` to use the CLI. Same PR as the v1 ships.
8. Publish to npm as `create-render-agent` (the unscoped name; the workspace name `@render-harness/create-render-agent` is the internal name only).

Steps 1–6 are local-only. Steps 7–8 are publish-time and need a separate sign-off on npm namespace ownership.
