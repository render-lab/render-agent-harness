# Inbox digest cron

A daily cron (8:00 UTC by default) that sends each connected user a morning briefing — calendar, pending replies, memory carryovers, and a chosen focus item.

**Runtimes:** cron (the trigger) + web (operator UI for sign-in) + worker (drains chat-style runs for ad-hoc re-runs).

**Capabilities pre-selected:** `@render-harness/cap-google` (Gmail + Calendar, per-end-user OAuth) and `@render-harness/cap-memory-pg`.

**Env vars:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CONNECTIONS_ENCRYPTION_KEY`. Same setup as `gmail-triage`.

**Use this as a starting point if:** you want a daily morning briefing that respects the privacy of each user's inbox (no shared service account) and lives in their own email rather than a Slack channel. Pairs naturally with `meeting-prepper` (which feeds memory) and a memory-aware chat agent (which the user can ask follow-up questions).

The `cap-google__gmail_send` tool is HITL-gated by default — once you've trusted the agent for a few mornings, remove it from `permissions.requireApproval` to make it fully autonomous.
