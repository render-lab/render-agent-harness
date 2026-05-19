# @render-harness/cap-intercom

Intercom capability pack for the [Render Agent Harness](https://github.com/render-lab/render-agent-harness). **First dual inbound+outbound pack** — combines the chat-surface pattern of `cap-slack` / `cap-github` with the per-end-user OAuth pattern of `cap-google` / `cap-notion`.

- **Inbound**: `POST /connectors/intercom` receives Intercom webhook deliveries (HMAC-SHA1 verified using the OAuth app's client secret as the HMAC key), normalizes the payload, and enqueues a harness run onto a conversation keyed by `intercom-${sha256(workspace_id:conversation_id)}`. Idempotency uses Intercom's notification id so re-deliveries dedupe.
- **Outbound**: 7 tools (2 in `read` mode) use `secrets.requireConnection("intercom")` to fetch a per-end-user access token at call time.

## Install

```sh
pnpm add @render-harness/cap-intercom
```

## Configure

```yaml
capabilities:
  - pack: "@render-harness/cap-intercom"
    config:
      agent: support-bot              # which agent to enqueue inbound events to
      userId: cap-intercom            # default; the harness userId that owns the connection
      accessMode: read_write          # or "read"
```

Env vars on the harness service:

```sh
INTERCOM_OAUTH_CLIENT_ID=...
INTERCOM_OAUTH_CLIENT_SECRET=...     # also the webhook HMAC key
CONNECTIONS_ENCRYPTION_KEY=...
```

In the [Intercom Developer Hub](https://developers.intercom.com/) → your app:

1. **OAuth redirect URL**: `${RENDER_EXTERNAL_URL}/connections/intercom/callback`.
2. **Webhook URL**: `${RENDER_EXTERNAL_URL}/connectors/intercom`. Subscribe to topics:
   - `conversation.user.created`
   - `conversation.user.replied`
   - `conversation.admin.assigned`
   - `conversation.admin.closed`
   - (Optional: `conversation.admin.replied`, `conversation.admin.noted`, `conversation.admin.opened`, `conversation.admin.snoozed`, `conversation.admin.unsnoozed`.)
3. **Scopes**: configured on the app's Authentication settings page, not at OAuth-handshake time. For full functionality of the write tools, enable "Read conversations" + "Write conversations" + "Read admins" + "Read tags".

Then in the operator UI's Connections tab, click "Connect Intercom" — the user grants access, the harness stores the refresh token encrypted, and the workspace name appears as the connection label.

## Tools

Always available:

- `intercom.read_conversation({ conversation_id })` — full state, assignee, tags, and chronological transcript.
- `intercom.list_recent_conversations({ open?, assignee_id?, k? })` — paginated list of recent conversations with snippets.

`accessMode: read_write` (default) adds:

- `intercom.reply({ conversation_id, admin_id, body, type? })` — `type: "comment"` (customer-visible, default) or `"note"` (admin-only private).
- `intercom.assign({ conversation_id, admin_id, assignee_id?, team_id? })`
- `intercom.add_tag({ conversation_id, tag_id, admin_id })`
- `intercom.close({ conversation_id, admin_id, body? })`
- `intercom.snooze({ conversation_id, admin_id, snoozed_until })` — Unix seconds in the future.

The `admin_id` is **required** on every write tool — Intercom attributes actions to a specific admin (typically a dedicated "Bot" admin). Set it once in your agent's system prompt or memory.

## Config keys

| Key | Type | Default | What it does |
|---|---|---|---|
| `agent` | string | first agent in the bundle | Which agent the connector enqueues inbound events to. |
| `userId` | string | `"cap-intercom"` | The harness userId the connection is stored against and tools look up at call time. |
| `accessMode` | `"read"` \| `"read_write"` | `"read_write"` | `"read"` drops the 5 write tools. |
| `clientIdEnv` | string | `"INTERCOM_OAUTH_CLIENT_ID"` | Override the env var name. |
| `clientSecretEnv` | string | `"INTERCOM_OAUTH_CLIENT_SECRET"` | Override the env var name. |

## v1 limitations

- **Workspace-scoped**: one Intercom workspace per cap-intercom installation. Multi-workspace fan-out (one harness agent serving multiple Intercom workspaces) is deferred to v2.
- **No bot replies vs admin replies distinction**: all replies are posted via the admin endpoint with the configured `admin_id`. Intercom's `bot` user type isn't separately modeled in v1.
- **No custom data attributes** on conversations / contacts.
- **No article / help-center API** — out of scope for v1.

## Skill

`intercom-support` (loadable via `load_skill`) — when to reply vs assign vs close, the `comment` vs `note` distinction, what `admin_id` means, how conversation state interacts with replies.

## Versioning

First release at `0.6.0` matching the family minor. See `docs/AGENTS.md` for the family-wide versioning model.
