# Slack standup

A cron-driven agent that posts a "what shipped yesterday" digest to a Slack channel every weekday morning. Pairs naturally with sibling agents that write to memory (e.g. `slack-pr-notifier`, `work-monitor`, `release-notes-cron`) — the standup just reads what they captured.

**Runtimes:** cron (weekdays at 14:00 UTC) + web (so you can re-run the digest on demand from the operator UI / curl).

**Capabilities pre-selected:** `@render-harness/cap-slack` (read_write, with `slack_send_message` gated behind HITL approval the first time you use it) + `@render-harness/cap-memory-pg`.

**Env vars:** `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `STANDUP_CHANNEL`. The bot needs `chat:write` + must be a member of `STANDUP_CHANNEL` before the first cron tick.

**Use this as a starting point if:** you want an automated team digest without dragging humans into a daily ritual. Edit the cron schedule and the system prompt's section names to fit your team's flow.
