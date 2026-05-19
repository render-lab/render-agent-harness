# @render-harness/cap-granola

## 0.8.0

### Minor Changes

- 03f9f11: Edit system prompts in the operator UI's Agents tab. New `PATCH /agents/:slug/system-prompt` route on `@render-harness/web` clones the managed repo via the same deploy-key path that powers the model edit, rewrites `agents[i].agent.systemPrompt` in `render-harness.yaml`, commits, and lets Render auto-deploy roll out the change. The Agents tab grows an "edit" affordance next to the system-prompt section for builtin (`kind: chat`) agents; custom (`kind: custom`) agents stay read-only and surface a "defined in `<entrypoint>` — edit in code and redeploy" hint instead, because their prompt lives in TypeScript source.

  Pieces:
  - **`@render-harness/core`** — new `AgentSource` type and optional `source` field on `AgentDefinition`. Populated by the registry; unset for hand-authored `defineAgent({...})` calls.
  - **`@render-harness/registry`** — new `mutateAgentSystemPrompt` mutator + `AgentNotEditableError` in `repo-mutations`. `defineChatAgent` stamps `source: { kind: "builtin" }`; `defineFromConfig` stamps `source: { kind: "custom", entrypoint }` on dynamic-imported agents. Multi-line prompts emit as `|` block scalars so the on-disk YAML stays readable; round-trip through `parseDocument` preserves comments and unrelated fields.
  - **`@render-harness/contracts`** — `AgentSummary` grows `source` and `systemPrompt` (full body). The full prompt is already accessible via `runAgent` at runtime; surfacing it on `GET /agents` lets the operator UI populate its edit modal without a second round-trip.
  - **`@render-harness/web`** — new route mounted in `serveWeb`. Deploy-key path is preferred; falls through to wizard-proxy for harnesses scaffolded before May 2026's GITHUB_DEPLOY_KEY migration. Returns 409 `agent_not_editable` (with `entrypoint` pointer) when the targeted agent is `kind: custom`.
  - **`@render-harness/ui`** — `EditSystemPromptModal` with a resizable textarea, char count, 50,000-char limit, and the same committed → restarting → restored toast chain the existing edit-model and install-capability flows use.
  - **`@render-harness/wizard`** — new `PATCH /api/agents/:slug/system-prompt` route. Sibling of `/api/agents/:slug/model`, same `WIZARD_SHARED_SECRET` auth + Octokit commit shape, same deprecation log warning operators to rotate to the deploy-key path.

  Per [AGENTS.md](https://github.com/render-lab/render-agent-harness/blob/main/AGENTS.md#minor-bumps-must-be-coordinated-across-the-whole-family) this is a coordinated minor cut: every published first-party harness package goes to the same `0.8.0` baseline so `harnessVersion: "^0.8.0"` in scaffolded `render-harness.yaml` files satisfies every dep. Existing managed harnesses need a manual bump of `harnessVersion` and their `@render-harness/*` dep ranges before the new route is reachable; the scaffolded `render-harness.yaml` is updated automatically by `bundle-gallery.ts`.

### Patch Changes

- Updated dependencies [03f9f11]
- Updated dependencies [89c74d6]
  - @render-harness/core@0.8.0
  - @render-harness/registry@0.8.0

## 0.7.0

### Minor Changes

- ef657b6: Initial release of `@render-harness/cap-granola`. First **API-key + polling** pack in the wave-1 family — Granola has no OAuth (the WorkOS-based flow is reverse-engineered only and not stable) and no webhooks (Granola hasn't shipped them as of 2026 Q2).

  Three read-only tools against the user's Granola account:
  - `granola.list_notes({ since?, until?, limit?, page_token? })` — paginated list of meeting notes by date range.
  - `granola.read_note({ note_id, include_transcript? })` — full transcript + structured summary + action items + attendees for one note.
  - `granola.poll_recent({ since_minutes?, k? })` — lists notes in the window, dedups against the pack-managed `granola_seen_notes` table, returns only the new ones. Use from a recurring cron run to detect new meetings without re-processing old ones.

  The `granola_seen_notes` table is created via the pack's `migrations` slot (added to `CapabilityPack` in `@render-harness/registry@0.6.0`). The harness's boot-time migration runner applies it before any tool runs — **second real consumer of the runner mechanism**, after `cap-memory-pg` pgvector mode.

  Per Q3=A from the wave-1 shipping plan, the polling primitive stays in-pack for v1. Phase 8 retro decides whether to extract `definePollingConnector` into `@render-harness/registry` based on what cap-figma and any batch-2 polling needs surface.

  Rate limits: Personal API keys are capped at 25 burst / 5 req/sec sustained per Granola docs. The pack respects `Retry-After` on 429 with one short retry, then surfaces a typed error so the agent backs off.

  Missing-key behavior mirrors `cap-search-exa`: the pack logs a `console.warn` and registers no tools when `GRANOLA_API_KEY` is unset, rather than crashing every agent in the bundle.

  Skill: `granola-notes` — picks between the three tools, explains the polling dedup semantics, lays out the canonical cap-granola + cap-notion cross-pack pattern (Granola finds the meetings, Notion records the summaries).

  Config keys:
  - `apiKeyEnv` (default `"GRANOLA_API_KEY"`) — override the env var name.
  - `keyType` (default `"personal"`) — `"personal"` or `"enterprise"`.

  Required env on the harness service:
  - `GRANOLA_API_KEY` — generate at https://app.granola.ai/settings/api-keys.

  15+ tests cover pack metadata, env schema, migration slot output (id + SQL shape), tool surfacing (3 tools when key set, 0 with warn when unset, env override), skills, `granolaFetch` (Bearer auth, query handling, 429 retry-once, 401 typed error), and `formatGranolaError` translations (401 → key rotation guidance, 429 → rate-limit + retry-after, generic → status + message passthrough).

  v1 deliberately deferred: OAuth via WorkOS (wait for Granola to ship official docs), webhooks (wait for Granola), fan-out (one-harness-run-per-new-note — `poll_recent` returns to caller for sequential processing in v1), search (Granola's `/notes` doesn't expose semantic search), write operations (Granola's API is read-only today).

- 0a772da: Coordinated 0.7.0 minor cut: per-harness SSH deploy keys replace `WIZARD_SHARED_SECRET` for edit-in-UI commits.

  **What changed for harness operators**
  - New transport for the operator UI's Install capability and Edit model flows: the deployed harness clones its own managed repo via SSH using a per-deployment `GITHUB_DEPLOY_KEY`, runs the same pure planner/mutator the wizard used to run, and pushes the commit directly. No wizard in the path.
  - Wizard scaffold flow (`/new`) generates an ed25519 keypair, registers the public half on the new repo as a deploy key with write access, and surfaces the private key + `GITHUB_DEPLOY_REPO_SSH_URL` on the scaffold-done page with copy buttons for the Render Blueprint env-var prompt.
  - CLI-scaffolded harnesses can self-serve via the new `npx create-render-agent deploy-key [--repo owner/name]` subcommand — generates a keypair and prints paste-ready instructions for the GitHub deploy-key page and the Render Environment tab.
  - Add agent (`POST /agents/add`) still proxies through the wizard with `WIZARD_SHARED_SECRET` in Wave 1 (it depends on runtime-entries templates that live in `create-render-agent`); a follow-up minor cut will move it to the deploy-key path too. Until then, keep `WIZARD_SHARED_SECRET` set alongside the deploy-key vars if you use Add agent.

  **What changed in the published API**
  - `@render-harness/registry` exports two new subpaths:
    - `@render-harness/registry/deploy-keys` — pure `generateDeployKeypair()` returning OpenSSH-format ed25519 keys, suitable for both wizard scaffold and the CLI subcommand. Shared so both stay byte-identical.
    - `@render-harness/registry/repo-mutations` — re-export of the pure `planCapabilityInstall`, `mutateCapabilityInstallYaml`, `mutateAgentModel`, `planAgentAdd`, etc., previously private to the wizard. Consumed by both the wizard's existing routes and the harness's new deploy-key commit path so they share one implementation of every YAML mutation.
  - `@render-harness/contracts` adds `repoSshUrl?: string | null` to `DeploymentInfo.repoLocator`. Backfilled in `enrichDeploymentInfo` from `org` + `repo` as `git@github.com:<org>/<repo>.git` when an explicit SSH URL isn't pinned in `.render-harness/agent.json`.
  - `@render-harness/web` adds `packages/web/src/lib/git-commit.ts` (`withRepoClone`, `commitFilesToRepo`) plus `packages/web/src/lib/commit-shim.ts` (`pickCommitPath`). The `capability-install` and `agent-model` routes wire these in with a back-compat fallback to the wizard proxy when `WIZARD_SHARED_SECRET` is set but `GITHUB_DEPLOY_KEY` isn't.
  - `@render-harness/registry/emitter` adds `GITHUB_DEPLOY_KEY` and `GITHUB_DEPLOY_REPO_SSH_URL` as `sync: false` envVars on every UI-enabled web service in the generated `render.yaml`. The Config tab's `implicitOperationalVars` learns about both; `WIZARD_SHARED_SECRET`'s description is reworded as legacy.
  - `create-render-agent`'s `.env.example` template appends commented-out `GITHUB_DEPLOY_KEY` / `GITHUB_DEPLOY_REPO_SSH_URL` blocks (only when `ui: true`) alongside the existing `WEB_API_KEY` / `UI_COOKIE_SECRET` block.

  **Deprecation**

  The wizard's `/api/capabilities/install`, `/api/agents/add`, `/api/agents/:slug/model` routes still accept `Authorization: Bearer WIZARD_SHARED_SECRET` and continue to function for harnesses scaffolded before this cut. Each route logs a one-shot deprecation warning on first authenticated hit per process. These endpoints will be removed in a future minor cut; rotate harnesses to deploy keys when convenient. See `docs-site/src/content/docs/managed-repo-commits.mdx` for the operator-facing setup walkthrough.

  **Runtime requirements**

  The deploy-key flow shells out to the system `git` binary plus OpenSSH client (`ssh`). Both are present in Render's native Node runtime per https://render.com/docs/native-runtimes#tools-and-utilities. Custom Dockerfile users should ensure `git` and `openssh-client` are installed; the harness defensively probes at first use and surfaces an actionable `git binary not on PATH` error if missing.

  **Why coordinated minor**

  Per `AGENTS.md` "Minor bumps must be coordinated across the whole family" — `@render-harness/registry`, `@render-harness/contracts`, and `@render-harness/web` ship breaking-shape changes (new exports, new `repoLocator.repoSshUrl` field, new commit-shim route shape) and the runtime version check would red-banner every existing managed harness if any first-party package crossed 0.7 without the rest. Every first-party package + every capability pack bumps to 0.7.0 together.

### Patch Changes

- Updated dependencies [2213ab0]
- Updated dependencies [0a772da]
- Updated dependencies [ab4dbd1]
  - @render-harness/registry@0.7.0
  - @render-harness/core@0.7.0

## 0.6.0

### Minor Changes

- Initial release. Granola.ai meeting-notes capability pack. First **API-key + polling** pack in the wave-1 family — no OAuth in v1 (Granola's official auth is bearer API keys; the WorkOS-based OAuth flow is documented only via reverse-engineering and not stable). No webhooks either; Granola hasn't shipped them.

  Surfaces:
  - Three read-only tools:
    - `granola.list_notes({ since?, until?, limit?, page_token? })` — paginated list of meeting notes by date range.
    - `granola.read_note({ note_id, include_transcript? })` — full transcript + structured summary + action items + attendees for one note.
    - `granola.poll_recent({ since_minutes?, k? })` — lists notes in the window, dedups against the pack-managed `granola_seen_notes` table, returns only the new notes. Use from a recurring cron run to detect new meetings without re-processing old ones.
  - One bundled skill (`granola-notes`) covering tool selection, polling semantics, common cross-pack patterns (Granola → Notion / Slack), and rate-limit handling.
  - One env-schema entry for `GRANOLA_API_KEY` plus an optional `GRANOLA_KEY_TYPE` for personal-vs-enterprise key selection.
  - One pack migration registered via the new `migrations` slot (added in `@render-harness/core@0.6.0`) — creates `granola_seen_notes(note_id PK, first_seen_at)` at boot. **Second real consumer of the pack-migration runner**, after `cap-memory-pg` pgvector mode.

  Polling semantics:
  - `poll_recent` lists notes in the last `since_minutes` (default 60, max 7 days), `INSERT ... ON CONFLICT DO NOTHING` on each id, returns only the freshly-inserted ones. Subsequent polls within the window see them as "already processed" and skip.
  - Per Q3=A from the wave-1 shipping plan, the polling primitive stays in-pack for v1. Phase 8 retro decides whether to extract `definePollingConnector` into `@render-harness/registry` based on what cap-figma and any batch-2 polling needs surface.
  - Fan-out (one harness run per new note) is deferred — the calling run processes the returned list sequentially.

  Rate limits: 25 burst / 5 req/sec sustained on Personal API keys. The pack respects `Retry-After` on 429 with one short retry, then surfaces a typed error so the agent backs off.

  Config keys:
  - `apiKeyEnv` (default `"GRANOLA_API_KEY"`) — override the env var name.
  - `keyType` (default `"personal"`) — `"personal"` or `"enterprise"`; affects which notes are accessible.

  Required env on the harness service:
  - `GRANOLA_API_KEY` — generate at https://app.granola.ai/settings/api-keys (Business or Enterprise plan required for Personal keys; admin-issued for Enterprise keys).

  Missing-key behavior mirrors `cap-search-exa`: the pack logs a `console.warn` and registers no tools when `GRANOLA_API_KEY` is unset, rather than crashing every agent in the bundle.
