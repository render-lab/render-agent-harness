# @render-harness/cap-figma

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

### Patch Changes

- @render-harness/registry@0.6.1

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
