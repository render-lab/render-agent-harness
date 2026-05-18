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

Set `accessMode: read_write` to enable write tools:

- `slack.send_message`
- `slack.add_reaction`
- `slack.update_message`

Use `permissions.requireApproval` for write tools if the agent should ask before posting or changing Slack messages.

## Test Commands

```sh
pnpm --filter @render-harness/cap-slack build
pnpm --filter @render-harness/cap-slack test
```
