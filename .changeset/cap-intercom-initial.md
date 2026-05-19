---
"@render-harness/cap-intercom": minor
---

Initial release of `@render-harness/cap-intercom`. First **dual inbound+outbound** capability pack — combines the chat-surface pattern of `cap-slack` / `cap-github` (HMAC-verified webhook on `/connectors/intercom`) with the per-end-user OAuth pattern of `cap-google` / `cap-notion` (tools call `secrets.requireConnection("intercom")`).

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
