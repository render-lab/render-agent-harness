# @render-harness/cap-notion

## 0.7.0

### Minor Changes

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

- Initial release. Notion capability pack via the harness's per-end-user OAuth connections API. Each end user clicks "Connect Notion" in the operator UI; the pack stores their access token encrypted and tools fetch it at call time.

  Surfaces:
  - `oauthProviders` registration for Notion (id `notion`, displayName `Notion`). Uses the new `refreshTokenOptional: true` field on `OAuthProviderConfig` added in `@render-harness/core@0.6.1` — Notion's standard public OAuth flow issues long-lived access tokens with no refresh token, so refresh-on-use is a no-op and the stored access token is returned unchanged from `secrets.requireConnection("notion")` until the operator reconnects.
  - 8 local tools across three surfaces:
    - Pages: `notion.read_page`, `notion.create_page`, `notion.append_blocks`, `notion.update_page_properties`.
    - Databases: `notion.query_database`, `notion.create_database_row`, `notion.update_database_row`.
    - Search: `notion.search`.
  - 2 skills (`notion-pages`, `notion-databases`) loadable via the built-in `load_skill` tool.
  - `fetchAccountLabel` pulls the connected workspace name from `/v1/users/me` so the Connections tab shows "Connected as MyWorkspace" instead of just "google".

  Block-tree depth is capped at 1 in v1 (`read_page` returns the page's top-level blocks but does not recurse into child pages). Filter shape for `query_database` is a JSON passthrough.

  Config keys:
  - `accessMode` (string, default `read_write`) — `read` drops the write tools (`create_page`, `append_blocks`, `update_page_properties`, `create_database_row`, `update_database_row`).
  - `clientIdEnv` / `clientSecretEnv` (string) — override the env var names for the Notion OAuth public-integration client id / secret. Defaults: `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`.

  Required env on the harness service:
  - `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET` — from your Notion public integration's OAuth settings.
  - `CONNECTIONS_ENCRYPTION_KEY` — already required by the connections API.

  Register the redirect URI `${RENDER_EXTERNAL_URL}/connections/notion/callback` in the Notion integration's OAuth configuration.
