# @render-harness/web

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

- Updated dependencies
  - @render-harness/core@0.4.1
  - @render-harness/contracts@0.4.1
  - @render-harness/runtime-worker@0.4.1
  - @render-harness/registry@0.4.1

## 0.4.0

### Minor Changes

- Realign onto the 0.4.x family line. Coordinated minor cut accidentally cascade-patched `web` to `0.3.1` instead of carrying it onto the new minor, leaving the runtime harness version check red for every deployed harness (no single `harnessVersion` semver range satisfies both `web@0.3.1` and `core@0.4.0`). See AGENTS.md § "Realigning a drifted package" and the matching "Things that bit us recently" entry.

## 0.3.1

### Patch Changes

- Updated dependencies
  - @render-harness/core@0.4.0
  - @render-harness/contracts@0.4.0
  - @render-harness/registry@0.4.0
  - @render-harness/runtime-worker@0.4.0

## 0.3.0

### Minor Changes

- 70ab0f4: Zero-config Add agent in the deployed harness.
  - `@render-harness/web`: new `GET /agents/catalog` route proxies the wizard catalog same-origin so the browser never crosses origins (the wizard ships no CORS headers). Response is cached in-process for 60s. The proxy and the existing add/install/edit-model routes now default the wizard URL server-side; `RENDER_HARNESS_WIZARD_URL` becomes an opt-in override.
  - `@render-harness/wizard`: `listAddableAgents` now flattens every gallery entry, not just bundles. `planAgentAdd` accepts agents that reference a builtin (no `agent.entrypoint`) and produces a null `sourceFilePath` so the route skips the src/ probe and write. Single-agent gallery entries (chat, support-bot, research-cron, work-monitor) are addable from the operator UI.
  - `@render-harness/registry`: `enrichDeploymentInfo` defaults `wizardServiceUrl` to the public wizard. The Config tab's description of `RENDER_HARNESS_WIZARD_URL` is reworded to "override only" and `WIZARD_SHARED_SECRET`'s description is clarified. The gallery loader walks `src/` for every entry kind so single-agent entries that ship custom source are picked up too.
  - `@render-harness/ui`: Add agent panel is always visible on the Agents tab and shows a one-line hint when the deployment can't commit (missing repo locator / shared secret). The catalog modal swaps the flat `<select>` for a filterable card grid, surfaces actionable error codes (`needs_install`, `wizard_shared_secret_not_configured`, `repo_locator_missing`, `wizard_service_not_configured`), and reuses `useDeployWatch` + the toaster so successful adds show committed → restarting → restored with a Reload action.

### Patch Changes

- Updated dependencies [70ab0f4]
  - @render-harness/registry@0.2.4
  - @render-harness/ui@0.2.5

## 0.2.6

### Patch Changes

- toaster for changes pushed to render
- Updated dependencies
  - @render-harness/contracts@0.2.2
  - @render-harness/ui@0.2.4
  - @render-harness/core@0.2.2
  - @render-harness/registry@0.2.3
  - @render-harness/runtime-worker@0.2.2

## 0.2.5

### Patch Changes

- fixes
- Updated dependencies
  - @render-harness/ui@0.2.3

## 0.2.4

### Patch Changes

- c2cc5c6: `PUT /config/env-vars/:name` now explicitly POSTs to
  `/v1/services/:id/deploys` with `deployMode: "deploy_only"` after the
  env-var write succeeds. Render's env-var API endpoint only persists
  the value — it does not roll the service — so the previous flow
  saved the new value but the running container kept the old
  `process.env`. Symptoms: clicking "Save & restart" in the Config tab
  appeared to do nothing, and toggling Vitals (which writes
  `RENDER_HARNESS_VITALS_ENABLED`) never flipped the feature on
  because the freshly-saved env never made it into a restarted
  process. The response now reports `restart: "queued"` or
  `restart: "save_only"` (with a `deployError` payload) so the UI can
  surface when Render rejected the deploy trigger and the operator
  needs to redeploy manually.
- Updated dependencies [c2cc5c6]
  - @render-harness/ui@0.2.2

## 0.2.3

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.2.2

## 0.2.2

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/contracts@0.2.1
  - @render-harness/core@0.2.1
  - @render-harness/registry@0.2.1
  - @render-harness/runtime-worker@0.2.1
  - @render-harness/ui@0.2.1

## 0.2.1

### Patch Changes

- Updated dependencies
  - @render-harness/ui@0.1.5

## 0.2.0

### Minor Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/contracts@0.2.0
  - @render-harness/core@0.2.0
  - @render-harness/registry@0.2.0
  - @render-harness/runtime-worker@0.2.0
  - @render-harness/ui@0.1.4
