# @render-harness/cap-intercom

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
