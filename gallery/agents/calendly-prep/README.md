# Calendly prep

A web + worker agent that receives Calendly `invitee.created` webhooks, looks up the attendee in Gmail + memory, and posts a 1-pager to Slack 30 minutes before the meeting.

**Runtimes:** web + worker. Calendly webhook lands at `/connectors/webhook-generic` and enqueues; the worker drains and runs the lookup loop.

**Capabilities pre-selected:** `@render-harness/cap-webhook-generic` (HMAC verify for Calendly), `@render-harness/cap-google` (per-end-user OAuth — the host signs in once to grant Gmail + Calendar read scope), `@render-harness/cap-slack` (`slack_send_message` HITL-gated), `@render-harness/cap-memory-pg` (persists the prep so meeting-prepper/chief-of-staff can re-use it).

**Env vars:** `CALENDLY_WEBHOOK_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CONNECTIONS_ENCRYPTION_KEY`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `PREP_CHANNEL`.

**Use this as a starting point if:** you take a lot of sales / hiring / external meetings via Calendly and you want a "who is this person again, and what's the context?" briefing before each one. Output goes to a private Slack channel by default — easy to swap to Gmail send (use `cap-google__gmail_send`) if you prefer email.
