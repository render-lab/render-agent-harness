# Onboarding & distribution direction

## Context

The render-harness core is built and operational:

- A working `runAgent` shared by four runtimes (`runtime-web`, `runtime-cron`, `runtime-worker`, `runtime-workflows`).
- A real manifest schema, `HarnessConfigSchema` in `packages/registry/src/schema.ts`, with a loader (`defineFromConfig` in `packages/registry/src/load-config.ts`) and a Zod-validated surface covering `agent`, `runtimes[]`, `model`, `mcpServers[]`, `capabilities[]`, `permissions`, `sampling`, and `envSchema[]`.
- Five deployment-ready examples in `examples/` (`web-chat`, `citations-monitor`, `support-agent`, `deploy-agent`, `operator-demo`), each with its own `render-harness.yaml`, agent entry, and runtime entrypoint.
- A canonical starter at `templates/render-harness-entry/`, with `templates/README.md` noting the long-term intent that "these will live in their own GitHub template repos."
- Current onboarding prose in `docs/registry-guide.md`, which documents the manual flow: `cp -r path/to/render-harness/templates/render-harness-entry my-agent`.

What is **not** captured anywhere is the coherent UX/distribution story: how real users — technical *and* non-technical — discover, scaffold, customize, and deploy agents on Render. This doc records the direction reached in a design discussion so future work on each surface has a shared north star.

This is a **direction doc, not an execution plan.** Several decisions are intentionally left open in §5. Per-surface execution plans (CLI scaffolder, gallery, UI wizard) come later as their own `docs/*-plan.md` files.

## 1. Locked direction

Three decisions came out of the design discussion. Each shapes everything downstream.

### 1.1 Multi-runtime fan-out is the default

An agent is the unit of authorship, not a runtime. Real-workload users will commonly expose a single `defineAgent` through multiple trigger surfaces at once — e.g. a support agent that's a web chat (user-initiated), a worker (inbound emails from a queue), *and* a cron (nightly digest) — all sharing the same prompt, tools, and Postgres/KV-backed state.

The schema already supports this: `HarnessConfigSchema.runtimes[]` is an array. The UX must reflect it. Single-runtime examples remain as Hello-World on-ramps but are not the destination.

This is not just a stylistic preference — it's the production model the project is being designed for.

### 1.2 The manifest is the unifying contract

`render-harness.yaml` is the single artifact every surface produces or consumes:

- CLI scaffolder writes one.
- UI wizard writes one.
- Gallery entries *are* one (plus agent source).
- Deploy pipeline reads one to provision Render services.

This is the architectural lever that keeps the three surfaces from becoming three separate systems. CLI and UI are front-ends to the same backend. The gallery is a place where pre-filled manifests live.

Implication: anything that wants to be authorable through the no-code path must be expressible in the manifest schema. Schema extensions are likely (gallery metadata, see §5).

### 1.3 Examples are inspiration, not forks

`examples/*` and gallery entries are read-mostly references. Users do not fork an example to start a project; they author into their own repo (via CLI or UI), copying snippets or capability references from examples as needed.

This dodges the classic "stale fork" problem — heavy customization is the norm for agents (prompt, tools, surfaces), so a per-flavor forkable repo is mostly scaffolding the user tears apart, with no upstream-improvement path. Library updates flow through `pnpm up @render-harness/*`, not through rebasing a fork.

## 2. The three surfaces

| Surface | Audience | Artifact produced | State today |
|---|---|---|---|
| Community gallery / registry | All users (discoverability) | Pre-filled manifests + agent source | Does not exist |
| CLI scaffolder (`npx create-render-agent`) | Technical users | Project tree mirroring `templates/render-harness-entry/` | Does not exist; current path is manual `cp -r` |
| UI scaffolder (browser wizard) | Non-technical users | Same artifact as CLI, deployed automatically | Does not exist |

### 2.1 Community gallery / registry

A place where users share **agents** *and* **capabilities**. Capability sharing is independently valuable and likely more frequent: a tool, MCP server config, or skill is smaller and more reusable than a full agent, and slots into the existing `capabilities[]` and `mcpServers[]` arrays on `HarnessConfigSchema`.

Gallery entries are not deployable templates — they are starting points. The user picks an entry; the CLI or UI emits a fresh project containing (or referencing) that entry's manifest.

Where the gallery physically lives is open (see §5).

### 2.2 CLI scaffolder

`npx create-render-agent` (exact name TBD). Wizard prompts:

- Agent name
- System prompt
- Model (defaults to `claude-sonnet-4-6` per locked decision #6 in `docs/architecture.md`)
- Capabilities to enable (selectable list, including built-ins and gallery entries)
- MCP servers to wire up
- Trigger surfaces to expose (web HTTP / cron / worker / workflow — checkboxes, multi-select)
- Optional: starting from a gallery entry vs. blank

Output: a project tree shaped like `templates/render-harness-entry/`, with `render-harness.yaml` filled in, agent entry stubbed, runtime entrypoints written for each selected trigger, and a `README.md` covering local dev + deploy.

This is the lowest-risk surface to build first — it leverages everything that exists already and replaces a manual `cp -r` step.

### 2.3 UI scaffolder

Render-hosted browser wizard. Same input questions as the CLI, same `render-harness.yaml` emitted. End state: user clicks Deploy → Render provisions services + Postgres + KV from the manifest → agent is live with a chat URL and any configured cron/queue triggers.

The UI is form-based, not a code editor. Whether to provide an inline code escape hatch (for an agent body hook) is open (see §5).

The UI sits on top of the managed-repo model, §3.

## 3. The managed-repo model

For users who do not have GitHub (the typical no-code persona), the UI scaffolder needs somewhere to put the manifest and code. Two options were considered:

| Model | What it is | Tradeoff |
|---|---|---|
| Opaque managed state | No repo. Manifest lives in Render's DB. Generic harness image reads manifest at boot. | Fastest first-five-minutes, no Git infra. Graduation to code requires a destructive "export to repo" step that fresh-generates code with no history. |
| **Managed repo** (recommended) | Render-owned GitHub org hosts a private repo per agent. UI reads/writes it via API. | Same first-five-minutes feel from the user's POV, but graduation is non-destructive — the real repo with real commit history transfers to the user's GitHub when they connect it. |

The managed-repo model is the recommended path because graduation matters: the project's stated goal is real workloads, and a one-way no-code door breaks that.

### 3.1 No collaborators while managed

The Render bot is the **only collaborator** on the managed repo during the managed phase. The end user never needs a GitHub account during this phase; the UI is the sole authoring interface. Consequences:

- The per-user GitHub seat cost concern largely evaporates — the bot is one account, not 100k.
- The no-GitHub path is genuinely no-GitHub — users don't even sign up.
- UI and repo cannot drift, because the UI is the only writer.
- From the user's POV during managed mode, the experience is indistinguishable from opaque managed state.

### 3.2 Graduation = native repo transfer

When the user later connects their own GitHub:

1. Render initiates a GitHub repo transfer from the `render-managed-agents`-style org to the user's account.
2. The user accepts on the receiving side.
3. Full commit history is preserved. The user now has direct push access for the first time.

One click, non-destructive. After transfer the UI can either keep working against the user-owned repo via GitHub API, or step aside in favor of local-dev workflows.

### 3.3 Alternative: self-hosted Git

A Gitea/Forgejo instance run by Render, with mirroring to GitHub only on graduation, is a viable alternative for tighter isolation and no GitHub quota exposure. Deferred unless GitHub-org costs or compliance properties become a real concern at scale. (See §5.)

## 4. Relationship to existing code and docs

This direction is intentionally additive — it does not change the manifest schema, the runtimes, or the existing examples. It builds on:

- `packages/registry/src/schema.ts` — `HarnessConfigSchema` is the contract surface for all three new surfaces.
- `packages/registry/src/load-config.ts` — `defineFromConfig`, unchanged; CLI/UI emit files this loader already understands.
- `templates/render-harness-entry/` — shape the CLI scaffolder targets.
- `templates/README.md` — already foreshadows the GitHub-template direction; the gallery is a generalization.
- `examples/` — become gallery entries (with metadata) when the gallery exists; their authoring shape does not change.
- `docs/registry-guide.md` — current manual prose; once the CLI ships, this guide rewrites its "Scaffold from the template" section to point at `npx create-render-agent`.
- `docs/architecture.md` — runtime/state/signal design this UX sits on top of; cross-referenced but unchanged.

## 5. Open questions (intentionally undecided)

These need decisions before per-surface execution plans can be finalized. They are not decided in this doc; surfacing them here prevents future work from silently committing to a choice.

1. **Managed-repo backing store** — GitHub-org from day one vs. self-hosted Git until graduation. Tradeoff: operational simplicity and free GitHub primitives vs. tighter privacy/isolation and no quota exposure.
2. **Gallery location** — render.com sub-route, standalone site, GitHub org, npm scope, or hybrid. Affects discoverability, brand, and how entries are versioned.
3. **Offboarding semantics for managed repos** — when a user stops paying or leaves, does the repo auto-transfer? Archive? Grace period? Affects legal/support and should be designed up front.
4. **UI escape hatch** — does the wizard include an inline code editor for an agent body hook, or stay strictly form-based until graduation? Form-only is simpler; an editor delays the moment users hit the ceiling.
5. **Manifest gallery-metadata extensions** — `HarnessConfigSchema` likely needs additions for gallery entries: tags, author, license, screenshots, version. Design deferred.
6. **One gallery or two** — agents and capabilities share one surface (with filtering) or live in separate galleries. They have different shapes (a capability is consumed *into* an agent, not deployed standalone) so the answer may be "one index, two presentation modes."
7. **CLI name** — `create-render-agent`, `create-render-harness`, `create-harness-agent`, or other. Affects npm namespace and discoverability via `npx create-*`.

## 6. Rough phased path

Not a Gantt — just an order-of-attack that minimizes risk and builds the simpler primitives first.

- **Phase 1 — CLI scaffolder.** Builds on `templates/render-harness-entry/` and the existing manifest. No new infrastructure. Highest immediate value for technical users. Unblocks fast feedback on the wizard prompt shape that the UI scaffolder will reuse.
- **Phase 2 — Gallery v1.** Static curated index pointing at GitHub repos (or in-monorepo entries). Uses the existing manifest schema with minimal metadata additions. The CLI scaffolder learns to start from a gallery entry, which validates the schema before the UI surface depends on it.
- **Phase 3 — Managed-repo + UI wizard.** The heavy lift. Depends on (a) the wizard prompt shape proved out by Phase 1 and (b) gallery entries existing as starter sources from Phase 2. Includes the Render-owned GitHub org, the bot's commit pipeline, and the graduation/transfer flow.
