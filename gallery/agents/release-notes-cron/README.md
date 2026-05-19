# Release notes cron

A weekly cron (Friday 16:00 UTC) that reads merged GitHub PRs from the last 7 days and drafts a sectioned release-notes markdown document into memory.

**Runtimes:** cron + web (so you can re-run on demand).

**Capabilities pre-selected:** `@render-harness/cap-github` (read-only) and `@render-harness/cap-memory-pg` (for storing the draft + last-run timestamp).

**Env vars:** `GITHUB_TOKEN`, `NOTES_REPO` (e.g. `acme/api`), optional `NOTES_BRANCH` (default `main`).

**Use this as a starting point if:** you ship weekly and want a first draft already written before the Friday-afternoon "what did we do this week?" meeting. The agent never publishes the notes — it just puts them in memory. Pair with `slack-standup` to surface the draft in chat, or hook a chat agent up to memory and ask "give me the release notes for this week".
