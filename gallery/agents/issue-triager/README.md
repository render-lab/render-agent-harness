# Issue triager

A web + worker agent that auto-labels and routes new Linear issues to the right team. Every label add and team move is HITL-gated.

**Runtimes:** web + worker. Linear webhook lands at `/connectors/linear` and enqueues; the worker reads the issue, classifies it, and drafts the triage actions.

**Capabilities pre-selected:** `@render-harness/cap-linear` (read_write, with `linear_add_labels`, `linear_set_team`, `linear_assign_issue`, and `linear_create_comment` all gated behind HITL approval).

**Env vars:** `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`. The API key needs read + write on Issues for the relevant workspace; configure the webhook in Linear → Settings → Webhooks pointed at `/connectors/linear` with the Issue event enabled.

**Use this as a starting point if:** you want a triage bot that turns "untriaged: 47" into "untriaged: 0" without taking decisions away from humans. The agent classifies along type / severity / team and writes its reasoning into a comment so the approver has context before clicking through.
