# @render-harness/cap-intercom

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

### Patch Changes

- @render-harness/registry@0.6.1

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
