# Hermes-inspired feature opportunities

[Hermes Agent](https://hermes-agent.nousresearch.com/) positions itself as an always-on agent that lives across chat channels, learns from repeated work, schedules automations from natural language, delegates to isolated subagents, and uses broad web, browser, image, and voice tools. This harness already has durable state, MCP, skills, capability packs, bundles, cron, Workflows, and the operator UI, so the best opportunities are product refinements on top of those primitives rather than a new agent runtime.

Use this note to decide which Hermes-like ideas deserve roadmap space after the current bundle, admin UI, recurring task, and connector plans land.

## Recommended priorities

| Rank | Feature | Fit | User value | Risk | Why |
|---|---|---:|---:|---:|---|
| 1 | Natural-language recurring automations | High | High | Medium | The recurring task plan already defines schedules, notifications, builtins, and worker reconciliation. Hermes' scheduling pitch mostly becomes a better chat and UI experience on top of those pieces. |
| 2 | Workflow-backed delegation UX | High | High | Medium | `trigger_workflow` already gives agents a durable handoff path. The missing layer is operator visibility: parent and child runs, approvals, status, and results in one place. |
| 3 | Multi-channel connector packs | High | High | Medium | Slack and generic webhooks fit the capability-pack model and avoid a fifth runtime. They make agents reachable where users already work. |
| 4 | Reviewed memory-to-skill suggestions | Medium | High | High | Persistent memory exists, and skills are explicit. A review step can turn repeated procedures into proposed `SKILL.md` files without letting the agent silently change its own behavior. |
| 5 | `@file` and `@url` context injection | Medium | Medium | Medium | The operator UI can let users attach files, URLs, previous runs, or deployment objects to a turn. This improves day-to-day control without adding unsafe default filesystem or terminal access. |

## Feature touchpoints

### Natural-language recurring automations

Build from [`docs/recurring-tasks-plan.md`](./recurring-tasks-plan.md) and [`docs/cron-workflows-plan.md`](./cron-workflows-plan.md). The core implementation already points at an `agent_schedules` table, `schedule_*` builtins, a pg-boss reconciler, and Slack, webhook, and inbox notifications.

Implementation areas:

- [`packages/core/src/builtins/index.ts`](../packages/core/src/builtins/index.ts) for registering schedule builtins after the recurring task work lands.
- [`packages/runtime-worker/src/index.ts`](../packages/runtime-worker/src/index.ts) for pg-boss reconciliation and notification dispatch.
- [`packages/ui/web/src/App.tsx`](../packages/ui/web/src/App.tsx) and the admin scheduling pane from [`docs/admin-ui-plan.md`](./admin-ui-plan.md) for schedule visibility and CRUD.

Product shape:

- Users ask an agent to create or update a schedule in natural language.
- The agent calls schedule builtins, scoped to the current user.
- The UI shows schedules, next fire times, delivery status, and recent outputs.

### Workflow-backed delegation UX

Build from [`docs/cron-workflows-plan.md`](./cron-workflows-plan.md), [`docs/bundle-authoring.md`](./bundle-authoring.md), and the `trigger_workflow` builtin. This keeps Hermes-style delegation aligned with Render Workflows instead of introducing ad hoc child processes.

Implementation areas:

- [`packages/core/src/builtins/triggerWorkflow.ts`](../packages/core/src/builtins/triggerWorkflow.ts) for the delegation primitive.
- [`packages/runtime-workflows/src/index.ts`](../packages/runtime-workflows/src/index.ts) for durable task execution and checkpointing.
- [`packages/web/src/routes/runs.ts`](../packages/web/src/routes/runs.ts) and [`packages/ui/web/src/tabs`](../packages/ui/web/src/tabs) for linking parent runs to triggered child runs.

Product shape:

- Parent runs show a "delegated work" section when `trigger_workflow` fires.
- Child runs link back to the parent run and inherited user request.
- Approval-gated delegations surface before the Workflow task starts.

### Multi-channel connector packs

Build from [`docs/connectors-plan.md`](./connectors-plan.md). Keep inbound channels as capability contributions mounted by `@render-harness/web`, not as core builtins.

Implementation areas:

- [`packages/registry/src/capability.ts`](../packages/registry/src/capability.ts) for the connector contribution contract.
- [`packages/web/src/index.ts`](../packages/web/src/index.ts) for mounting connector routes.
- New capability packages such as `packages/capabilities/cap-slack` and `packages/capabilities/cap-webhook-generic`.

Product shape:

- Start with Slack and generic HMAC webhooks.
- Preserve threaded Slack conversations through the conversations model.
- Add Discord, email, or other gateways only after the connector contract proves itself.

### Reviewed memory-to-skill suggestions

Build from the memory capability, the existing `load_skill` builtin, and the admin UI plan. Treat this as a proposal workflow, not automatic self-modification.

Implementation areas:

- [`packages/capabilities/cap-memory-pg/src/index.ts`](../packages/capabilities/cap-memory-pg/src/index.ts) for persisted memory retrieval.
- [`packages/core/src/builtins/loadSkill.ts`](../packages/core/src/builtins/loadSkill.ts) for the current skill loading model.
- [`docs/admin-ui-plan.md`](./admin-ui-plan.md) for reviewing, enabling, or rejecting proposed skills.

Product shape:

- A background analysis job looks for repeated successful procedures in memory and run history.
- The system drafts a candidate skill with provenance: source runs, memories, and tool traces.
- An operator reviews, edits, and accepts the skill before it becomes available to agents.

### `@file` and `@url` context injection

Add lightweight context attachment to the operator chat. This borrows Hermes' ergonomic context model without making the core worker a filesystem or terminal host.

Implementation areas:

- [`packages/ui/web/src/App.tsx`](../packages/ui/web/src/App.tsx) and chat components for mention parsing and attachment previews.
- [`packages/web/src/index.ts`](../packages/web/src/index.ts) for resolving allowed attachment sources.
- [`packages/core/src/builtins/fetchUrl.ts`](../packages/core/src/builtins/fetchUrl.ts) for URL fetch safety rules.
- `@render-harness/cap-filesystem` for deployments that opt into path-scoped file reads.

Product shape:

- `@url` fetches web content through the existing SSRF-protected path.
- `@file` works only when the deployment has an explicit filesystem capability and path allowlist.
- `@run` or `@deployment` can attach known harness objects without sending users through manual copy and paste.

## Defer or keep optional

- **Sandboxed code execution** belongs in an opt-in capability pack with a dedicated execution backend. Do not add terminal or arbitrary filesystem tools to core, because the worker service is multi-tenant by design.
- **Voice and TTS** can wait. They expand the product surface but do not strengthen the current Render-native deployment story as much as schedules, delegation, connectors, and admin visibility.
- **Broad messenger support** should follow Slack and generic webhooks. Telegram, WhatsApp, Signal, Discord, and email each bring different auth, retry, threading, and delivery semantics.
- **Automatic skill writing** should stay behind operator review. Silent skill installation makes agent behavior harder to audit and debug.
- **Hermes-style local agent OS features** such as terminals, Python RPC scripts, and snapshot rollback should not become default runtime behavior. If needed, ship them as isolated capability packs or separate templates with clear security boundaries.

## Suggested sequence

1. Ship recurring automations and notifications.
2. Polish workflow delegation in the run UI.
3. Land Slack and generic webhook connector packs.
4. Add reviewed memory-to-skill suggestions to the admin UI.
5. Add `@file`, `@url`, and object mentions in operator chat.
6. Revisit sandboxing, voice, and broader channel support after the first five are stable.

## Existing strengths to preserve

The harness already has the durable, deployable foundation that Hermes advertises in a different form: Postgres-backed state, multiple runtimes, MCP, builtins, skills, capability packs, Workflows, bundles, and a gallery. Preserve those boundaries. New Hermes-inspired features should make the existing system feel more like an always-on assistant without weakening the explicit security and deployment model.
