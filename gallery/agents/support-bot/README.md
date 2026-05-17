# Support bot

A web + worker pair for Slack support workflows. The web service accepts Slack Events at `/connectors/slack` and enqueues a run on the pg-boss queue. The worker pulls jobs and runs the agent through the harness.

**Runtimes:** web + worker.

**Use this as a starting point if:** you're building a Slack support bot that should keep each Slack thread tied to one harness conversation.

The default system prompt is a first-line triage agent — replace it with your own when you scaffold.

Set `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`, then configure Slack Events to send `app_mention` and message events to `/connectors/slack`.
