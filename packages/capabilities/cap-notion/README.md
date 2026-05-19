# @render-harness/cap-notion

Notion capability pack for the Render agent harness. Uses per-end-user OAuth via the harness's [Connections API](../../../docs-site/src/content/docs/connections-api.mdx) — each end user clicks "Connect Notion" in the operator UI, the harness stores their access token encrypted, and tools fetch it at call time.

Notion's public-integration OAuth flow returns long-lived access tokens with no refresh token. This pack relies on the `refreshTokenOptional: true` field on `OAuthProviderConfig` (added in `@render-harness/core@0.6.1`); refresh-on-use is a no-op. If Notion 401s on a tool call, the pack returns an actionable error telling the user to reconnect at `/ui/connections`.

## Install

```sh
pnpm add @render-harness/cap-notion
```

## Configure

```yaml
capabilities:
  - pack: "@render-harness/cap-notion"
    config:
      accessMode: read_write   # or "read"
```

Env vars on the harness service:

```sh
NOTION_OAUTH_CLIENT_ID=...      # from your Notion integration's OAuth settings
NOTION_OAUTH_CLIENT_SECRET=...
CONNECTIONS_ENCRYPTION_KEY=...  # already required by the connections API
```

In your Notion integration (https://www.notion.so/profile/integrations):

1. Set the integration type to **Public**.
2. Add the redirect URI `${RENDER_EXTERNAL_URL}/connections/notion/callback`.
3. Copy the OAuth client id + secret into the env vars above.

End users granting access also need to share each page/database they want the integration to see, via Notion's "Add connections" menu on the page (`•••` top-right → "Add connections" → pick your integration). cap-notion surfaces an actionable `restricted_resource` error message when this hasn't happened.

## Tools

8 tools in `read_write` mode, 3 tools in `read` mode (search, read_page, query_database):

| Tool | Mode | Description |
|---|---|---|
| `notion.search` | always | Workspace search by title. Returns id, type (page \| database), parent. |
| `notion.read_page` | always | Page metadata + top-level blocks flattened to markdown-like text. Block depth capped at 1. |
| `notion.create_page` | read_write | Create page under a parent page OR database row. |
| `notion.append_blocks` | read_write | Add blocks to an existing page. |
| `notion.update_page_properties` | read_write | Patch properties / archive. |
| `notion.query_database` | always | Filter + paginate database rows. Filter shape is a Notion-API passthrough. |
| `notion.create_database_row` | read_write | Insert row. |
| `notion.update_database_row` | read_write | Patch row properties. |

## Config keys

| Key | Default | Notes |
|---|---|---|
| `accessMode` | `"read_write"` | `"read"` drops the four write tools. |
| `clientIdEnv` | `"NOTION_OAUTH_CLIENT_ID"` | Override when the env var is named differently. |
| `clientSecretEnv` | `"NOTION_OAUTH_CLIENT_SECRET"` | Same. |

## Skills

| Skill | When the agent should load it |
|---|---|
| `notion-pages` | The user references a Notion page or asks you to write into Notion. |
| `notion-databases` | The user wants to read/write structured rows backed by a Notion database. |

Loaded on demand via `load_skill` — not in every system prompt by default.

## Versioning

First release at `0.6.0` matching the family minor. See `docs/AGENTS.md` for the family-wide versioning model.
