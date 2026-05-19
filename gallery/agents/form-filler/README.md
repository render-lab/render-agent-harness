# Form filler

A Workflows-mode agent that completes a multi-step web form on a remote site using a real headless browser — with HITL approval before the final submit.

**Runtime:** workflows only. Durable, observable, and HITL-friendly. Each task input is `{ url, fields, submitGoal }`.

**Capabilities pre-selected:** `@render-harness/cap-browser-browserbase` (with the click + submit tools gated behind `permissions.requireApproval`) and `@render-harness/cap-memory-pg` (for capturing confirmation receipts).

**Env vars:** `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`.

**Budget:** `maxIterations: 60`, `maxCostUsd: 3`, `maxWallSeconds: 1200`.

**Use this as a starting point if:** you have a recurring form to fill out — vendor onboarding, expense submissions, weekly reporting — and you'd like the agent to do everything *except* the final submit while you watch. The agent screenshots after every field for an audit trail and pauses for `ask_user` on ambiguity (rather than guessing). Payment fields, account-deletion confirmations, and legal-agreement checkboxes are explicitly excluded from auto-fill in the system prompt.
