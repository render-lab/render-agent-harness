# `@render-harness/cap-slack`

Slack Events and Web API tools for agents in the Render harness.

Use this pack when an agent should receive Slack Events API webhooks, keep one conversation per Slack thread, and optionally reply or react in Slack.

## Configuration

Drop the pack into `render-harness.yaml`:

```yaml
capabilities:
  - pack: "@render-harness/cap-slack"
    config:
      signingSecretEnv: "SLACK_SIGNING_SECRET"
      botTokenEnv: "SLACK_BOT_TOKEN"
      accessMode: "read"
```

Set these environment variables on the entry that loads the agent:

- `SLACK_SIGNING_SECRET`: Slack signing secret used to verify Events API requests.
- `SLACK_BOT_TOKEN`: Slack bot token used for thread reads and optional write tools.

## Connector

The pack mounts the `slack` connector at `/connectors/slack`. Configure that URL in Slack's Events API settings.

The connector accepts Slack URL verification challenges and enqueues a run for `app_mention` and `message` events. Events from bots are ignored. By default, message edit events are ignored.

Each Slack thread maps to one harness conversation, so follow-up messages in the same thread continue the same conversation.

## Config Keys

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `agent` | string | default agent | Agent name to enqueue runs for. |
| `userId` | string | `cap-slack` | User ID stored on enqueued runs. |
| `signingSecretEnv` | string | `SLACK_SIGNING_SECRET` | Env var that contains the Slack signing secret. |
| `botTokenEnv` | string | `SLACK_BOT_TOKEN` | Env var that contains the Slack bot token. |
| `accessMode` | `read` or `read_write` | `read` | Enables write tools only when set to `read_write`. |
| `allowedChannels` | string[] | all channels | Restricts accepted events and tool calls to listed Slack channel IDs. |
| `includeEdits` | boolean | `false` | Enqueue `message_changed` events when true. |

## Tools

Read tools are available when `SLACK_BOT_TOKEN` is set:

- `slack.get_thread` — read a Slack thread's messages.
- `slack.get_channel_history` — read recent Slack channel messages.
- `slack.get_user_info` — resolve a Slack user ID (for example `U0B4357MH7H`) to a display name, real name, and handle.
- `slack.get_channel_info` — resolve a Slack channel ID (for example `C0AQHA6M3PS`) to a channel name and metadata.

`slack.get_thread` and `slack.get_channel_history` also auto-enrich their responses so agents don't have to render raw IDs:

- Each message gains a `user_display_name` field with the best available label (`display_name` → `real_name` → `name`).
- Each message gains a `text_resolved` field where `<@U…>` mentions become `@display_name` and `<#C…|name>` mentions become `#name`.
- The response gains a `resolved_users` map keyed by user ID and a `resolved_channel` object describing the requested channel.

User and channel lookups are cached for the lifetime of the agent process to keep enrichment cheap across turns.

### Channel and user inputs

Every tool that takes a `channel` parameter (`slack.send_message`, `slack.get_thread`, `slack.get_channel_history`, `slack.get_channel_info`, `slack.add_reaction`, `slack.update_message`) accepts any of:

- A Slack channel ID — `C0AQHA6M3PS`, `G0…`, `D0…`. Used verbatim.
- A `#channel-name` — resolved to a channel ID via `conversations.list` (cached for the agent process). Requires `channels:read` and/or `groups:read` scope on the bot token. The bot must also be a **member** of the channel for write actions.
- An `@user-handle` — resolved to a user ID via `users.list` (cached) and opened as a DM channel via `conversations.open`. Requires `users:read` scope plus `im:write` (and `chat:write` for sending).
- A Slack mention literal — `<#C0AQHA6M3PS|name>` or `<@U0B4357MH7H>`. The wrapping is stripped and the inner ID is used.

`slack.get_user_info` accepts a user ID (`U0B4357MH7H`), an `@handle`, or a bare handle (`ada.lovelace`); the latter two require `users:read`.

`allowedChannels` is enforced **after** resolution, against the canonical channel ID. So `allowedChannels: ["C0AQ…"]` correctly accepts `slack.send_message({ channel: "#that-channels-name" })` because the resolver returns `C0AQ…` before the gate check fires.

If the bot lacks the lookup scope, the tool returns an actionable error naming the scope (e.g. `Slack missing_scope: 'channels:read' needed (bot currently has: 'chat:write'). Add 'channels:read' to the bot's OAuth scopes in the Slack app config (api.slack.com → OAuth & Permissions → Bot Token Scopes), reinstall the app to the workspace, and redeploy.`) instead of failing silently. Agents that only ever address channels by ID don't need the read scopes; the resolver fast-paths `C…` / `G…` / `D…` / `U…` inputs without any API call.

### Scope coverage for name lookups

The resolver lists public and private channels in **separate** `conversations.list` calls and aggregates results from whichever succeeds. A bot with only `channels:read` gets a working name → id index for public channels; the private-channel call fails (caught, ignored). A bot with both scopes indexes both. A bot with neither sees the actionable `missing_scope` error above with the first missing scope named.

Other common Slack errors are also rewritten with hints: `not_in_channel` → "invite the bot with `/invite @<bot>`", `channel_not_found` → "ID invalid, archived, or not visible to the bot", `invalid_auth` / `token_revoked` → "reissue `SLACK_BOT_TOKEN`". Any other Slack platform code passes through verbatim with the `slack.<code>` annotation appended so the agent can branch on it.

Set `accessMode: read_write` to enable write tools:

- `slack.send_message`
- `slack.add_reaction`
- `slack.update_message`

Use `permissions.requireApproval` for write tools if the agent should ask before posting or changing Slack messages.

### Request timeouts and retries

The underlying `@slack/web-api` WebClient defaults to no per-request timeout and retries up to ten times over roughly 30 minutes, which lets a single rate-limited or transient-failure response hang a tool call indefinitely from the agent's perspective. This pack overrides those defaults with a 15-second per-request timeout and a bounded retry policy (3 retries, 0.5s → 3s backoff), so a failing call surfaces as a clear tool error within ~70 seconds worst case instead of appearing stuck. Agents using `slack.send_message` against high-traffic channels should still expect the occasional rate-limit error and either back off or use `permissions.requireApproval` to throttle posts.

## Test Commands

```sh
pnpm --filter @render-harness/cap-slack build
pnpm --filter @render-harness/cap-slack test
```
