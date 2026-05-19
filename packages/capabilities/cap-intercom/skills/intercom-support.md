---
name: intercom-support
description: Triage incoming Intercom conversations and act on them — reply, note, assign, tag, close, snooze.
when_to_use: Whenever a webhook delivery from Intercom kicks off a run, OR the user asks you to do something with Intercom (reply to a conversation, close a ticket, list open ones, etc.).
---

# Intercom support workflow

The cap-intercom pack exposes:

- `intercom.read_conversation({ conversation_id })` — full state, assignee, tags, and chronological transcript.
- `intercom.list_recent_conversations({ open?, assignee_id?, k? })` — paginated list with snippets.
- `intercom.reply({ conversation_id, admin_id, body, type? })` — `type: "comment"` (customer-visible, default) or `type: "note"` (admin-only private note).
- `intercom.assign({ conversation_id, admin_id, assignee_id?, team_id? })`
- `intercom.add_tag({ conversation_id, tag_id, admin_id })`
- `intercom.close({ conversation_id, admin_id, body? })`
- `intercom.snooze({ conversation_id, admin_id, snoozed_until })` — Unix seconds in the future.

## The admin_id

Almost every write tool requires `admin_id` — the Intercom admin id the action is attributed to. **The agent does not know this automatically.** Get it from the configured Intercom workspace before the first write: the operator should set up a "Bot" admin user and pass its id as the default via the agent's system prompt or a memory entry. If you don't have one, ask the user before posting anything customer-visible.

## When the webhook fires

Each Intercom webhook delivery enqueues a run on the harness conversation keyed by the Intercom conversation id (sha256 of `workspace_id:conversation_id`). Subsequent webhooks for the same conversation join the same harness conversation, so you see one continuous thread.

The initial run message contains:

- The topic (`conversation.user.created`, `conversation.user.replied`, etc.)
- The latest customer message body (HTML stripped)
- A hint to call `read_conversation` for the full transcript

Default workflow:

1. **Read** the conversation first if you need context: `intercom.read_conversation({ conversation_id })`.
2. **Decide**:
   - Common question with a known answer → `intercom.reply({ type: "comment", body: "..." })`.
   - Needs human attention → `intercom.assign({ assignee_id })` (or `team_id`).
   - Routine update / observation for the team → `intercom.reply({ type: "note", body: "..." })` (private, doesn't notify the customer).
   - Tag for downstream routing → `intercom.add_tag`.
   - Done → `intercom.close`.
   - Waiting on the customer → `intercom.snooze({ snoozed_until: <future-unix-seconds> })`.
3. **Be concise.** Customers see your `comment` replies verbatim. Quote their question when summarizing back, never fabricate product details, escalate when unsure.

## Conversation state matters

- `open` — active. Replies appear immediately.
- `closed` — done. Replying reopens it.
- `snoozed` — waiting. Replying unsnoozes it; the customer sees the reply.

`list_recent_conversations({ open: true })` is the right call when triaging "what's in my queue right now".

## comment vs note (the most common mistake)

- `type: "comment"` (default) — customer-visible. The customer's notification fires.
- `type: "note"` — internal admin note. Customer never sees it.

When in doubt, post a note first ("I'm proposing this reply: ...") and let the operator confirm before sending the public comment. The harness's `permissions.requireApproval` lets you gate `intercom.reply` separately from `intercom.assign` / `intercom.close`.

## Permissions and scopes

Tools call `secrets.requireConnection("intercom")` at runtime. If the user hasn't connected (or their token was revoked from the Intercom side), they'll see an actionable error pointing at `/ui/connections`. Tell them to reconnect there rather than guessing what went wrong.

The OAuth scopes for cap-intercom are configured **server-side on the Intercom app**, not requested per-OAuth-handshake. If you get `not_found` errors on conversations that the workspace clearly has, the app might be missing the "Read conversations" or "Write conversations" scope — operator opens the Intercom Developer Hub → the app → Authentication → scopes.
