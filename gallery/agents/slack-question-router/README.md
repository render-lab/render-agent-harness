# Slack question router

A web + worker agent that triages incoming Slack questions into FAQ / human / escalate buckets, replies to the easy ones, and tags the hard ones for a human.

**Runtimes:** web + worker. The web service receives Slack Events at `/connectors/slack` and enqueues; the worker pulls and runs the triage prompt.

**Capabilities pre-selected:** `@render-harness/cap-slack` (read_write, with `slack_send_message` and `slack_add_reaction` gated behind HITL approval the first time) + `@render-harness/cap-memory-pg` (so the bot learns recurring questions over time).

**Env vars:** `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, optional `ESCALATION_CHANNEL`. The bot needs `chat:write`, `reactions:write`, `app_mentions:read`, and `im:history` scopes; subscribe to `app_mention` and `message.im` events in the Slack app config.

**Use this as a starting point if:** you're running a help channel where most questions are repeats and you want an AI first responder that's honest about its limits. The system prompt errs heavily toward escalation when uncertain.
