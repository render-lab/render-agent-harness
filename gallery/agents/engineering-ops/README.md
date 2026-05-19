# Engineering ops

A sealed bundle that composes 4 atomic gallery agents into one harness deployment:

| Agent | Trigger | What it does |
|---|---|---|
| `ops-chat` | Web + worker | Chat front-end. Reads memory for what siblings wrote; answers "what's blocking?", "what shipped?", "who got assigned X?" |
| `pr-reviewer` | GitHub webhook (PR open/sync) | Drafts inline review comments (HITL-gated). Writes findings to memory. |
| `release-notes-cron` | Friday 16:00 UTC | Drafts release notes from merged PRs into memory. |
| `dependency-watcher` | Monday 13:00 UTC | Scans dep health across watched repos; posts digest to Slack. |
| `issue-triager` | Linear webhook | Auto-labels + routes new issues to teams (HITL-gated). |

All five share `cap-github`, `cap-linear`, `cap-slack`, and `cap-memory-pg`. Memory is the lingua franca — the chat agent surfaces what the cron and webhook-triggered agents wrote.

## Deploys to

- 1 web service (handles GitHub + Linear webhooks + Slack events + UI)
- 1 worker pserv (drains pr-reviewer, ops-chat, issue-triager queues)
- 2 Render Cron services (one per cron agent)
- 1 Postgres + 1 Key Value

Bundle vs five separate deployments: roughly $25-40/mo here vs $150+/mo if each agent ran its own harness.

## Env vars

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Auto-added by the emitter. |
| `GITHUB_WEBHOOK_SECRET` | yes | PR-reviewer webhook auth. |
| `GITHUB_TOKEN` | yes | PR reads + dep scans + release notes; needs `pull-requests:write` + `contents:read`. |
| `LINEAR_WEBHOOK_SECRET` | yes | Issue-triager webhook auth. |
| `LINEAR_API_KEY` | yes | Read + write Linear issues. |
| `SLACK_SIGNING_SECRET` | yes | Slack Events auth. |
| `SLACK_BOT_TOKEN` | yes | Slack chat write + dep-health posts. |
| `WATCHED_REPOS` | yes | Comma-separated `owner/repo` list. |
| `NOTES_REPO` | yes | `owner/repo` for release notes. |
| `DEPENDENCY_CHANNEL` | yes | Slack channel for dep-health digests. |

## Use this as a starting point if

You run engineering ops for a small-to-mid team and want one deployment that covers code review, release notes, dep health, and issue triage. The bundle is sealed in the wizard (no per-agent prompts) but every system prompt lives in the manifest — edit in place after scaffolding. Each agent in the bundle also exists as a standalone atomic entry (`pr-reviewer`, `release-notes-cron`, `dependency-watcher`, `issue-triager`) if you'd rather pick a subset à la carte.
