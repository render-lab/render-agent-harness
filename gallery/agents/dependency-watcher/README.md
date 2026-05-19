# Dependency watcher

A weekly cron (default: Monday 13:00 UTC) that scans dependency health across a list of GitHub repos and posts a focused digest to Slack — security alerts first, then ready-to-merge upgrades, then stuck stuff.

**Runtimes:** cron + web (so you can trigger a digest on demand from the operator UI).

**Capabilities pre-selected:** `@render-harness/cap-github` (read-only — no mutations) and `@render-harness/cap-slack` (read_write, `slack_send_message` HITL-gated first time).

**Env vars:** `GITHUB_TOKEN` (needs `security_events:read` for Dependabot + `contents:read` and `pull-requests:read` on the watched repos), `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `WATCHED_REPOS` (comma-separated `owner/repo` list), `DEPENDENCY_CHANNEL`.

**Use this as a starting point if:** you have a fleet of repos and want one weekly poke about what's actually worth doing — not Dependabot's daily spam. The system prompt explicitly skips the digest entirely when there's nothing actionable.
