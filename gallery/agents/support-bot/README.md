# Support bot

A web + worker pair for support workflows. The web service accepts inbound events (Slack Events, email webhooks, web-form posts) and enqueues a run on the pg-boss queue. The worker pulls jobs and runs the agent through the harness.

**Runtimes:** web + worker.

**Use this as a starting point if:** you're building any kind of inbound-event-driven agent — Slack support, email assistant, form responder. You'll typically wire the inbound webhook in the web service and post results from the worker (via Slack Web API, SES, or whichever channel matches your source).

The default system prompt is a first-line triage agent — replace it with your own when you scaffold.
