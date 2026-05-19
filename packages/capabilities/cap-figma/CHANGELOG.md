# @render-harness/cap-figma

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
  - @render-harness/registry@0.8.0

## 0.7.0

### Minor Changes

- 6804d03: Initial release of `@render-harness/cap-figma`. **First pack with granular per-action OAuth scopes** (post-Nov-2025 Figma platform update) — validates the granular-scope pattern that cap-atlassian / cap-hubspot / cap-salesforce will reuse, on a relatively small surface (7 tools).

  Tools (6 always-on read + 1 write opt-in):
  - `figma.read_file` — document tree, defaults to `depth: 2` to avoid token blowups, caps at depth 8; pass `ids: [...]` for targeted node reads.
  - `figma.read_file_nodes` — full subtree for specific node ids (max 200 per call).
  - `figma.read_file_metadata` — name, last_modified, role, thumbnail; cheap.
  - `figma.list_team_projects` / `figma.list_project_files` — navigation.
  - `figma.read_comments` — JSON or markdown-thread output (`as_md: true`).
  - `figma.post_comment` (in `read_write_comments` mode, default) — top-level, replies (`comment_id`), pinned via `client_meta` (coordinates or node).

  Granular scope assembly via `assembleFigmaScopes(accessMode)`:
  - `read` → `file_content:read`, `file_metadata:read`, `file_comments:read`, `current_user:read`.
  - `read_write_comments` (default) → adds `file_comments:write`.

  The pack ships only the new granular scope strings — deprecated coarse `files:read` / `file_read` stop working after Figma's Nov 2025 platform update.

  Reusable scope-drift error pattern (`formatFigmaError`): translates 403 / 401 / 404 / 429 into operator-actionable messages naming the action the agent was trying ("read file content", "post comment", etc.) and pointing at the Connections tab. Same flavor as cap-google's `withScopeHint`; a future helper extraction into `@render-harness/registry` is a Phase 8 retro decision.

  Two bundled skills:
  - `figma-files` — file structure, node id encoding, depth vs ids, token budgeting strategies.
  - `figma-comments` — read vs post, pin modes (free / coordinates / node), replying to threads, the comment-write scope-drift recovery flow.

  Deployment requirements:
  - Create a Figma OAuth app at https://www.figma.com/developers/apps.
  - Add the redirect URL `${RENDER_EXTERNAL_URL}/connections/figma/callback`.
  - **For single-org deployments, use the private/internal app type** — public OAuth apps require Figma's app-review approval before non-development users can connect.
  - Set `FIGMA_OAUTH_CLIENT_ID`, `FIGMA_OAUTH_CLIENT_SECRET`, `CONNECTIONS_ENCRYPTION_KEY` on the harness service.

  v1 deliberately deferred: components / styles library introspection, webhooks (defer until "react to file changes" use case appears), file-content writes (Figma's Plugin API only, not REST), Variables API, comment resolve/unresolve (not in REST).

  19 tests cover pack metadata + env flags, granular scope assembly per accessMode (with regex-pinned format `[a-z_]+:[a-z_]+`), OAuth provider URLs + env overrides + accessMode → defaultScopes mapping, tool surface (7 vs 6 by accessMode, namespacing under pack:cap-figma), skills (file existence), tool error paths (no SecretsContext, missing required args), and `formatFigmaError` translations (403 → reconnect with scope-drift guidance, 401 → reconnect, 500 → status + message passthrough).

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
  - @render-harness/registry@0.7.0

## 0.6.0

### Minor Changes

- Initial release. **First pack with granular per-action OAuth scopes** (post-Nov-2025 Figma platform update) — validates the granular-scope pattern that cap-atlassian / cap-hubspot / cap-salesforce will reuse, on a relatively small surface (~7 tools across files + comments).

  Surfaces:
  - 6 always-on read tools: `figma.read_file`, `read_file_nodes`, `read_file_metadata`, `list_team_projects`, `list_project_files`, `read_comments`.
  - 1 write tool when `accessMode: "read_write_comments"` (default): `figma.post_comment` (top-level, replies, pinned to coordinates or node).
  - 2 bundled skills: `figma-files`, `figma-comments`.
  - One env entry for the OAuth client id + secret + `CONNECTIONS_ENCRYPTION_KEY` (already required by the connections API).

  Scope assembly:
  - `accessMode: "read"` → `file_content:read`, `file_metadata:read`, `file_comments:read`, `current_user:read`.
  - `accessMode: "read_write_comments"` (default) → adds `file_comments:write`.

  The pack ONLY uses the new granular scope strings — the deprecated coarse `files:read` / `file_read` scopes stop working after Figma's Nov 2025 platform update.

  Defaults that protect token budgets:
  - `figma.read_file` defaults to `depth: 2` — pages → top-level frames. Caps at depth 8. For targeted reads pass `ids: [...]` instead.
  - Tools surface a typed scope-drift error (403) pointing at the Connections tab, naming the action the agent tried (`read file content`, `post comment`, etc.). Same pattern as cap-google's `withScopeHint`; reusable for future granular-scope packs.

  Deployment requirements:
  - Create a Figma OAuth app at https://www.figma.com/developers/apps.
  - Add the redirect URL `${RENDER_EXTERNAL_URL}/connections/figma/callback`.
  - **Public OAuth apps require Figma app-review approval** before non-development users can connect. Single-org deployments should use the private/internal app type to skip review entirely.
  - Set `FIGMA_OAUTH_CLIENT_ID` and `FIGMA_OAUTH_CLIENT_SECRET` on the harness service.
  - Set `CONNECTIONS_ENCRYPTION_KEY`.

  v1 deliberately deferred: components / styles library introspection, webhooks (Figma supports them; defer until we have a "react to file changes" use case), write operations beyond comments (Figma file edits go through the Plugin API, not REST), Variables API.

  Per the wave-1 shipping plan §Phase 7 DoD: if the `accessMode → scope-list` mapping turns out to be reusable for cap-atlassian (the next planned granular-scope pack), the Phase 8 retro extracts a helper into `@render-harness/registry`. For now it lives in cap-figma's `src/oauth.ts` as `assembleFigmaScopes`.
