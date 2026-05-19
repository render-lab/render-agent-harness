# @render-harness/cap-figma

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
