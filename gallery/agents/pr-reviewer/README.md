# PR reviewer

A first-pass code reviewer that drafts inline GitHub review comments — gated behind HITL approval so nothing posts without a human click.

**Runtimes:** web + worker. GitHub webhook lands at `/connectors/github` (subscribe to `pull_request`); the worker drains and runs the review prompt.

**Capabilities pre-selected:** `@render-harness/cap-github` (read_write, with all comment/review mutation tools gated behind `permissions.requireApproval` — your operator UI surfaces an approval card before each comment is posted).

**Env vars:** `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`. The token needs `pull-requests:write` and `contents:read` on the target repo(s).

**Use this as a starting point if:** you want an LLM doing first-pass diff review without it going feral and dumping a wall of nitpicks. The system prompt explicitly bans style nits and demands the reviewer prefix shaky findings with "I'm not sure, but...". Every comment routes through the HITL approval queue, so you can dismiss the noise before it hits the PR.
