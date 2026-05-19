# @render-harness/cap-notion

## 0.6.1

### Patch Changes

- @render-harness/registry@0.6.1

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
