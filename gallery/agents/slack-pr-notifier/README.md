# Slack PR notifier

A web + worker agent that watches a GitHub repo's PR events and posts opinionated summaries (not raw GitHub notifications) to a Slack channel.

**Runtimes:** web + worker. GitHub webhooks land at `/connectors/github` and enqueue; the worker fetches PR context and writes the summary.

**Capabilities pre-selected:** `@render-harness/cap-github` (read-only — no mutations), `@render-harness/cap-slack` (read_write, `slack_send_message` HITL-gated first time), `@render-harness/cap-memory-pg` (so `slack-standup` can pick up shipped PRs later).

**Env vars:** `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `PR_CHANNEL`. Configure the GitHub webhook URL to `/connectors/github` with content type `application/json` and events: pull request, pull request review.

**Use this as a starting point if:** GitHub's default Slack integration is too noisy. This agent skips drafts, skips Dependabot, and writes 3-4 lines of actual context per PR instead of dumping the title and a green button.
