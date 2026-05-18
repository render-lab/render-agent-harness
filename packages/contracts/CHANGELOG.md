# @render-harness/contracts

## 0.4.1

### Patch Changes

- Make `permissions.requireApproval` actually resumable end-to-end. Previously, runs paused by `requireApproval` got stuck in `awaiting_approval` forever: the operator UI's only resume affordance was `POST /runs/:id/input`, which appended the operator's text as a `role: "user"` message and re-enqueued the run **without** the `approvedToolCallIds` core expects. The worker then re-ran `runAgent` with no approved set, hit the same `requireApproval` gate, and paused on the same `tool_use_id` again — silently and indefinitely (and worse, the dangling user text wedged between an unanswered `tool_use` and nothing else could 400 the next model call).

  This patch wires the flow end-to-end:
  - **`@render-harness/core`** — `pauseForApproval` now writes `{ pauseReason: "awaiting_approval", awaitingApproval: { tool_use_id, name, input } }` into `agent_runs.metadata`, mirroring how `pauseForAwaitingInput` persists `ask_user` state. Lets every downstream consumer (web, UI, integration tests) read pause shape from the run row without walking the message log. Also re-exports `mergeRunMetadata` for callers that need to seed pause metadata in tests.
  - **`@render-harness/contracts`** — `RunSummary` gains a typed `pause: RunPauseInfo | null` field (discriminated by `reason: "awaiting_input" | "awaiting_approval"`). Adds `SendInputReq` documenting both wire shapes for `POST /runs/:id/input`.
  - **`@render-harness/web`** — `POST /runs/:id/input` now branches on the run's current pause reason: `awaiting_input` accepts `{ input: string }` exactly as before; `awaiting_approval` accepts `{ approvedToolCallIds: string[] }` and stuffs the approved ids into the re-enqueued `RunJob` payload. Cross-shape requests return `400 invalid_input` with a message naming the expected shape; a stale `tool_use_id` returns `409 stale_tool_use_id` with the pending id for the UI to retry against. `GET /runs/:id` now correctly runs the run row through `serializeRun` (it was returning the raw `AgentRun`, which is why no field added to `RunSummary` ever surfaced over the wire previously).
  - **`@render-harness/runtime-worker`** — `RunJob` gains an optional `approvedToolCallIds: string[]` field; `processJob` threads it into `runAgent({ approvedToolCallIds: new Set(...) })`, exactly mirroring how `@render-harness/runtime-workflows` already did it. Without this, every web-side approval was a no-op even after the route accepted it.
  - **`@render-harness/ui`** — `useConversationSession` fetches the run's pause shape whenever status flips to `paused` and exposes `pause`, `approveToolCall(toolUseId)`, and `approveBusy` from the hook. `ChatTab`'s `ToolCallBlock` consults the new `ChatSessionContext`; when a tool_use is the one blocking the run, the block highlights with a warn border and renders an inline **Approve and resume** button. `RunDetail`'s `ActionsCard` replaces the generic "send hitl input" textarea with branched UI: `awaiting_approval` renders the proposed tool + an Approve button; `awaiting_input` renders the original question, optional choice list, and a labelled reply form. Rejecting an approval still goes through `Cancel run`.

  End-to-end coverage in `packages/web/src/routes/runs.integration.test.ts`:
  - `awaiting_input` accepts `{ input }`, rejects `{ approvedToolCallIds }`.
  - `awaiting_approval` accepts `{ approvedToolCallIds }`, rejects `{ input }`, rejects stale tool_use_id, and the re-enqueued job carries the approved ids through verbatim.
  - `GET /runs/:id` surfaces `run.pause.reason` + `run.pause.payload.tool_use_id` derived from metadata.

  No new public exports beyond the additive `RunPauseInfo` type + `approveToolCalls` client + `approveToolCall` session method + `RunJob.approvedToolCallIds`, so this stays inside a coordinated patch cut with no family-wide minor bump.

## 0.4.0

### Minor Changes

- cap-slack: stop surfacing raw Slack user and channel IDs to agents.
  - `slack.get_thread` and `slack.get_channel_history` now auto-resolve user IDs and the queried channel ID, attach `user_display_name` per message, rewrite `<@U…>` and `<#C…|name>` references in `text_resolved`, and return `resolved_users` / `resolved_channel` maps in the response.
  - Adds two new read tools: `slack.get_user_info` and `slack.get_channel_info` for on-demand lookups (for example to label IDs the agent sees in attachments, payload metadata, or operator-provided text).
  - Lookups share an in-memory cache scoped to the agent process so repeated calls stay cheap across turns.

  The new tools trigger a coordinated family-wide minor bump per AGENTS.md "Minor bumps must be coordinated across the whole family". The other listed packages are packaging-only bumps with no behavioral change.

  `@render-harness/web` also drops its `@render-harness/ui` peerDependency in this cut. Web has never imported the UI statically — it dynamic-imports `@render-harness/ui` inside `wrapWithUiSessionIfAvailable` / `mountUiIfAvailable` with a guarded fallback. The peer declaration was advisory only, and it was the sole reason Changesets cascaded `web` to a MAJOR bump during every coordinated minor cut (see commit `420c904`'s manual workaround). Consumers that want the operator UI install `@render-harness/ui` explicitly alongside `@render-harness/web` exactly as before; the scaffolder already adds it as a regular dependency when `ui` is selected, so no scaffold changes are required.

  0.3.0##

### Minor Changes

- Coordinated 0.3.0 baseline cut across the entire first-party harness family.
  See AGENTS.md § "Minor bumps must be coordinated across the whole family".

## 0.2.2

### Patch Changes

- toaster for changes pushed to render

## 0.2.1

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.

## 0.2.0

### Minor Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.
