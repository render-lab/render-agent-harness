# Webhook router

A generic HMAC-verified webhook receiver that classifies incoming events and fans out to Slack notifications or Linear tickets based on severity.

**Runtimes:** web + worker. Webhooks land at `/connectors/webhook-generic` and enqueue; the worker drains and classifies.

**Capabilities pre-selected:** `@render-harness/cap-webhook-generic` (HMAC verify), `@render-harness/cap-slack` (read_write, `slack_send_message` HITL-gated), `@render-harness/cap-linear` (read_write, `linear_create_issue` HITL-gated).

**Env vars:** `WEBHOOK_SECRET` (HMAC secret your sender configures), `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `LINEAR_API_KEY`, `ROUTING_CHANNEL`, optional `ROUTING_TEAM`.

**Use this as a starting point if:** you've got 3+ tools each pinging Slack with their own opinionated format and you want one classifier in front of them. The agent's classification rules are explicit (severity hints, success/resolved → notify, anomalies → ticket, heartbeats → drop) — easy to tighten or relax in the system prompt.

Drops are never silent — anything genuinely ambiguous goes through as a notify with a "(unclassified — review)" prefix so you can refine the rules as you see real traffic.
