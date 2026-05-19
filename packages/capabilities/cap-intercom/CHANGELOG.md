# @render-harness/cap-intercom

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

- 0ae58fb: Initial release of `@render-harness/cap-intercom`. First **dual inbound+outbound** capability pack — combines the chat-surface pattern of `cap-slack` / `cap-github` (HMAC-verified webhook on `/connectors/intercom`) with the per-end-user OAuth pattern of `cap-google` / `cap-notion` (tools call `secrets.requireConnection("intercom")`).

  Inbound:
  - `POST /connectors/intercom` mounted via the pack's `connectors` slot.
  - HMAC-SHA1 verification using the OAuth app's `client_secret` as the HMAC key (Intercom signs every webhook with this). Tampered signatures → 401; missing client secret env → 500.
  - Subscribes to four conversation topics by default (`conversation.user.created`, `conversation.user.replied`, `conversation.admin.assigned`, `conversation.admin.closed`); five extra `.admin.*` topics pass through too if the operator subscribes their app to them.
  - Conversation key: `intercom-${sha256(workspace_id + ":" + conversation_id)}` — one Intercom conversation = one harness conversation.
  - Deterministic `runId` from `(workspace_id, conversation_id, notification_id)` so webhook re-deliveries dedupe via the harness's existing run-dedup; pinned by tests.

  Outbound (7 tools in `read_write`, 2 in `read`):
  - `intercom.read_conversation` — full state + chronological transcript (parts flattened, HTML stripped).
  - `intercom.list_recent_conversations` — paginated, optional open/assignee filters.
  - `intercom.reply` — `type: "comment"` (customer-visible) or `"note"` (admin-only private).
  - `intercom.assign` — to admin or team.
  - `intercom.add_tag` — by tag id.
  - `intercom.close` — with optional closing message.
  - `intercom.snooze` — until a Unix timestamp.

  Each write tool requires `admin_id` (Intercom attributes admin actions to a specific admin id; agents should keep this in memory or in their system prompt).

  OAuth via the harness connections API. `fetchAccountLabel` pulls the workspace name from `/me` so the Connections tab shows "Connected as MyWorkspace". Intercom configures scopes server-side on the app settings page rather than per-OAuth-handshake, so `defaultScopes` is empty.

  Required env on the harness service:
  - `INTERCOM_OAUTH_CLIENT_ID`, `INTERCOM_OAUTH_CLIENT_SECRET` — from the Intercom Developer Hub. The client secret doubles as the webhook HMAC key.
  - `CONNECTIONS_ENCRYPTION_KEY` — already required by the connections API.

  In the Intercom Developer Hub set the redirect URL to `${RENDER_EXTERNAL_URL}/connections/intercom/callback` and the webhook URL to `${RENDER_EXTERNAL_URL}/connectors/intercom`.

  v1 is workspace-scoped: one Intercom workspace per cap-intercom installation. Multi-workspace fan-out is deferred to v2 (see wave-1 shipping plan §Phase 5).

  Skill: `intercom-support` — triage workflow, comment-vs-note distinction, conversation states, what `admin_id` means.

  28 tests cover HMAC verification (valid / missing / wrong-prefix / tampered-body / wrong-secret / length-mismatch), webhook normalization (ping noop, unsupported topics, source body vs latest part, missing app_id/notification_id), pack metadata, OAuth provider URLs, tool surface by accessMode, connector mounting (missing secret → 500, bad signature → 401, valid delivery enqueues with the right conversation id / runId / userId / metadata), idempotency (same notification id → same runId), and ping noop response.

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

- Initial release. First dual inbound+outbound capability pack: combines the chat-surface pattern (cap-slack/cap-github connectors) with the per-end-user OAuth pattern (cap-google/cap-notion connections).

  Inbound:
  - `POST /connectors/intercom` mounted via the pack's `connectors` slot.
  - HMAC-SHA1 signature verification using the OAuth app's `client_secret` as the HMAC key (Intercom signs every webhook with this), header `X-Hub-Signature`.
  - Subscribes to four topics by default: `conversation.user.created`, `conversation.user.replied`, `conversation.admin.assigned`, `conversation.admin.closed`.
  - Conversation key: `intercom-${sha256(workspace_id + ":" + conversation_id)}` — one Intercom conversation = one harness conversation, surviving across multiple agent turns.
  - Idempotency: webhook re-deliveries with the same delivery attempt count deterministically produce the same `runId`, so the harness's run-dedup skips duplicates rather than enqueuing twice.

  Outbound (7 tools, all `read_write` mode; 2 always-on read tools in `read` mode):
  - `intercom.read_conversation` — full conversation with messages, assignee, tags.
  - `intercom.list_recent_conversations` — paginated list, optionally scoped to open / assignee.
  - `intercom.reply` — post a customer-visible comment OR a private admin note (configurable per call).
  - `intercom.assign` — assign to admin and/or team.
  - `intercom.add_tag` — add a tag by id.
  - `intercom.close` — close with an optional closing message.
  - `intercom.snooze` — snooze until a given timestamp.

  OAuth:
  - Standard OAuth 2.0 via the harness's connections API. Provider id `intercom`, displayName "Intercom".
  - `fetchAccountLabel` pulls the connected workspace name from `/me` so the Connections tab shows "Connected as MyWorkspace".

  Config keys:
  - `agent` — name of the agent the connector should target for inbound events. Defaults to the bundle's first agent.
  - `userId` — string to pass through as the run's `userId`. Defaults to `"cap-intercom"`. Tools call `secrets.requireConnection("intercom")` against this `userId`, so the connection must have been stored against the same id.
  - `accessMode` — `"read"` | `"read_write"` (default `"read_write"`). `read` drops the five write tools.
  - `clientIdEnv` / `clientSecretEnv` — override env var names for the Intercom OAuth client id / secret.

  Required env on the harness service:
  - `INTERCOM_OAUTH_CLIENT_ID`, `INTERCOM_OAUTH_CLIENT_SECRET` — from the Intercom app's OAuth configuration. The client secret doubles as the webhook HMAC key.
  - `CONNECTIONS_ENCRYPTION_KEY` — already required by the connections API.

  In the Intercom Developer Hub (https://developers.intercom.com/), set the OAuth redirect URL to `${RENDER_EXTERNAL_URL}/connections/intercom/callback` and add the webhook URL `${RENDER_EXTERNAL_URL}/connectors/intercom` with the four conversation topics enabled.

  v1 is **workspace-scoped**: one Intercom workspace per cap-intercom installation. Multi-workspace fan-out (one harness agent serving multiple Intercom workspaces) is deferred to v2 — see the wave-1 shipping plan §Phase 5.
