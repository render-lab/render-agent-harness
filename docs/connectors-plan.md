# Inbound connectors: `cap-slack` + `cap-webhook-generic`

## Context

The harness has zero inbound trigger surface today — every run starts via `POST /runs` or a cron tick. Anyone wanting a Slack bot, a GitHub webhook handler, or a Linear-event-driven agent has to build the plumbing from scratch each time. This plan adds inbound connectors as a **new capability slot** on the existing `CapabilityPack` interface, mounted as `POST /connectors/:key` routes on `@render-harness/web`. No fifth runtime, no core changes.

User-confirmed v1 shape:
- **Scope:** `cap-slack` + `cap-webhook-generic`. Discord/Socket Mode deferred.
- **Slack threading:** thread = continued conversation, via the landed `agent_conversations` model. A new Slack thread creates a conversation; replies in that thread enqueue new runs with the same `conversation_id`.
- **Reply:** tool-only. Agents call `slack.send_message` etc. explicitly. No `onJobResult` auto-post.

Consequence: with no auto-reply hook and no websocket listeners, **`@render-harness/runtime-worker` needs zero changes for v1**. All inbound plumbing lives in `web` + new capability packages.

## Dependency: conversations model

This plan rides on the conversations milestone described in `docs/conversations-plan.md` and migration `packages/core/sql/0002_conversations.sql`, which has now landed. Specifically, connector threading can rely on:

- `agent_conversations` table and `conversation_id` FK on `agent_runs` / `agent_messages`.
- `createConversation(pool, { id?, userId?, agentName, agentVersion, metadata? })` and `loadConversation(pool, id)` in `packages/core/src/state/repo.ts`.
- `enqueueRun(...)` in `@render-harness/runtime-worker` accepts a new optional `conversationId` and forwards it to `createRun`.
- `findActiveRunForConversation(pool, conversationId)` for the sequential-only 409 guard.

Connector implementation no longer needs to block on the conversations model. A small `enqueueIntoConversation(...)` convenience helper is still useful for connector code, but the underlying primitives are present.

## Architecture

### Connector contract — one new slot on `CapabilityPack`

Extend `packages/registry/src/capability.ts`:

```ts
export interface ConnectorWebCtx {
  pool: Pool;
  boss: PgBoss;
  queue: string;
  logger: Logger;
  /** Resolves the target agent for this connector instance. */
  resolveAgent: () => AgentDefinition;
  /** Pack config (already validated by the connector). */
  config: Record<string, unknown>;
  /** Convenience: enqueue a run, optionally tied to a conversation. */
  enqueueRun: (args: EnqueueRunArgs) => Promise<string>;
  /** Convenience: upsert-by-id then enqueue if no active run, else 409. */
  enqueueIntoConversation: (args: EnqueueIntoConversationArgs) => Promise<EnqueueResult>;
}

export interface ConnectorContribution {
  /** URL segment under /connectors/. Defaults to the pack's `name`. */
  key: string;
  /** Mounted at POST and GET /connectors/<key>. Verifies signature,
   *  derives a stable runId/conversationId, enqueues, returns synchronously. */
  webhook: (req: Request, ctx: ConnectorWebCtx) => Promise<Response>;
}

export interface CapabilityPack {
  // ...existing...
  connectors?: (ctx: PackContext) => ConnectorContribution[] | Promise<ConnectorContribution[]>;
}
```

Add `connectors: z.unknown().optional()` to `PackShapeSchema`. Outbound tools (`slack.send_message`, etc.) continue to flow through the existing `localTools()` path — no new mechanism needed.

### Web wiring

**New** `packages/web/src/connector-mount.ts` — mirrors `ui-mount.ts`:
- Resolves capability refs from `ServeWebOpts.connectors` (or `"from-config"` → read `render-harness.yaml`).
- Dynamic-imports each pack, calls `pack.connectors?.(ctx)`, returns `Map<key, { pack, contribution }>`.
- Missing pack → log + skip (don't crash web if `cap-slack` isn't installed).

**New** `packages/web/src/routes/connectors.ts` — `registerConnectorRoutes(app, ctx)`:
- `POST ${pathPrefix}/connectors/:key` and `GET ${pathPrefix}/connectors/:key` (Slack/GitHub use both).
- Skips the normal `auth` resolver — connector webhooks authenticate via signature, not Bearer.
- 404 if `:key` is not registered.
- Reads the raw body once (required for HMAC verification), passes the original `Request` plus `ConnectorWebCtx` to `contribution.webhook(...)`.
- Soft 3-second deadline: log a warning if the handler hasn't returned, so we know we're flirting with Slack's retry threshold.

**Modify** `packages/web/src/index.ts`:
- Add `connectors?: CapabilityRef[] | "from-config"` to `ServeWebOpts`.
- After existing route registration, conditionally `await mountConnectorsIfAvailable(app, ctx)`.

### Worker wiring

**No changes.** Tool-only reply + no Socket Mode = nothing to attach to the worker process in v1. Outbound tools are already merged into the agent via `localTools()` during `runAgent`'s tool resolution.

## `cap-slack` v1

Path: `packages/capabilities/cap-slack/`.

| File | Responsibility |
|---|---|
| `src/verify.ts` | HMAC-SHA256 over `v0:{ts}:{rawBody}`, constant-time compare against `X-Slack-Signature`, 5-minute timestamp window. Pure function. |
| `src/normalize.ts` | Handles `url_verification` (returns `{challenge}`), `event_callback.app_mention`, `event_callback.message` (skips bot_id, skips edits unless `config.includeEdits`). Returns `{ text, channel, thread_ts, team_id, event_id, user_id }`. |
| `src/convid.ts` | Deterministic conversation id from Slack thread: `slack-${sha256(team:channel:thread_ts).slice(0,16)}`. Top-level DMs (no `thread_ts`) get `thread_ts = ts` so first message also opens a conversation. |
| `src/tools.ts` | Three `LocalToolHandler`s: `send_message({channel, text, thread_ts?})`, `add_reaction({channel, ts, name})`, `update_message({channel, ts, text})`. Bot token from `config.botTokenEnv` (default `SLACK_BOT_TOKEN`). Channel allowlist via `config.allowedChannels`. |
| `src/index.ts` | `definePack({ name: "cap-slack", localTools, connectors })` — the `connectors` factory returns one `ConnectorContribution` whose `webhook` ties verify → normalize → upsert-conversation → `enqueueIntoConversation`. |

**Webhook flow** (inside `connectors[0].webhook`):
1. Read raw body, run `verify`. Bad signature → 401.
2. Parse JSON. If `type === "url_verification"`, return `{challenge}` (200).
3. Normalize event. Non-handled event types → 200 noop (Slack expects 200 to stop retries).
4. Derive `conversationId` via `convid.ts`. Derive deterministic `runId` from `event_id` for idempotency.
5. Call `ctx.enqueueIntoConversation({ conversationId, agentName: ctx.config.agent ?? sole agent, userId: config.userId ?? "cap-slack", runId, initialContent: [{type:"text", text}], metadata: { connector: "cap-slack", team_id, channel, thread_ts } })`.
6. If `enqueueIntoConversation` returns `{ status: "active_run_exists" }`, return 202 (let Slack retry; the active run will likely finish first). Otherwise 200.

**Config schema** (validated inside the pack — not yet first-class in Zod):
```yaml
capabilities:
  - pack: "@render-harness/cap-slack"
    config:
      agent: "support"               # required if multiple agents are mounted
      signingSecretEnv: SLACK_SIGNING_SECRET   # default
      botTokenEnv: SLACK_BOT_TOKEN             # default
      allowedChannels: ["C0123ABCD"]           # optional; permissive if omitted
      includeEdits: false                      # default
```

**Outbound tool namespacing:** existing `<pack>.<tool>` rule produces `cap-slack.send_message`. Agents reference it that way in their `permissions.allowedTools`.

## `cap-webhook-generic` v1

Path: `packages/capabilities/cap-webhook-generic/`.

A configurable HMAC-verified inbound webhook. No outbound tools (one-shot semantics; agent posts back via other means if needed).

| File | Responsibility |
|---|---|
| `src/verify.ts` | HMAC over raw body with configurable algorithm (`sha256` default), header name (`X-Signature-256` default), secret env, optional prefix (`sha256=`). Constant-time compare. |
| `src/extract.ts` | Pull initial message text from the request via configurable rules: dotted JSON path (`config.textPath: "payload.message"`), header pass-through, or full-body JSON.stringify fallback. |
| `src/index.ts` | `definePack` with `connectors` only (no `localTools`). |

**Config example** (GitHub-style):
```yaml
capabilities:
  - pack: "@render-harness/cap-webhook-generic"
    config:
      agent: "issue-triage"
      signatureHeader: "X-Hub-Signature-256"
      signaturePrefix: "sha256="
      secretEnv: GITHUB_WEBHOOK_SECRET
      idHeader: "X-GitHub-Delivery"            # used as deterministic runId
      textPath: "payload.issue.body"           # what becomes initialContent
      metadataPaths:
        repo: "payload.repository.full_name"
        issue_number: "payload.issue.number"
```

No threading: webhooks don't have a natural conversation key. Each delivery is a fresh single-run, no `conversationId` set.

## Out of scope for v1

- **Slack Socket Mode** — needs websocket lifecycle on the worker. Punt to v2.
- **Discord** — Gateway is WebSocket-only; depends on Socket Mode design.
- **Auto-reply via `onJobResult`** — user chose tool-only.
- **OAuth install flow / multi-workspace** — one pack config = one workspace, paste a token.
- **Slash commands / interactive components / block actions** — Events API only.
- **Generic webhook outbound** — `cap-webhook-generic` is inbound-only; the outbound case is "use `fetch_url` or build a dedicated capability."
- **First-class Zod schema for connector config** — packs self-validate. Promote to schema after the pattern proves out.

## File-by-file changes

**New:**
- `packages/capabilities/cap-slack/package.json`
- `packages/capabilities/cap-slack/src/index.ts`
- `packages/capabilities/cap-slack/src/verify.ts`
- `packages/capabilities/cap-slack/src/normalize.ts`
- `packages/capabilities/cap-slack/src/convid.ts`
- `packages/capabilities/cap-slack/src/tools.ts`
- `packages/capabilities/cap-slack/src/verify.test.ts`
- `packages/capabilities/cap-slack/src/normalize.test.ts`
- `packages/capabilities/cap-slack/src/index.integration.test.ts` (idempotency-on-retry + thread continuation)
- `packages/capabilities/cap-webhook-generic/package.json`
- `packages/capabilities/cap-webhook-generic/src/index.ts`
- `packages/capabilities/cap-webhook-generic/src/verify.ts`
- `packages/capabilities/cap-webhook-generic/src/extract.ts`
- `packages/capabilities/cap-webhook-generic/src/verify.test.ts`
- `packages/capabilities/cap-webhook-generic/src/extract.test.ts`
- `packages/web/src/routes/connectors.ts`
- `packages/web/src/connector-mount.ts`
- `packages/web/src/connector-mount.test.ts`
- `docs/connectors.md`

**Modified:**
- `packages/registry/src/capability.ts` — add `ConnectorContribution`, `ConnectorWebCtx`; add `connectors?` to `CapabilityPack`; extend `PackShapeSchema` with `connectors: z.unknown().optional()`.
- `packages/registry/src/index.ts` — re-export connector types.
- `packages/web/src/index.ts` — new `connectors` option on `ServeWebOpts`; wire `mountConnectorsIfAvailable`.
- `packages/runtime-worker/src/index.ts` — add `enqueueIntoConversation(...)` helper next to existing `enqueueRun(...)` (or in `packages/core/src/state/repo.ts` if conversations work places it there; defer to whatever conversations work establishes).
- `CLAUDE.md` — add "Inbound connectors" section pointing to `docs/connectors.md` and noting connectors are capabilities, not a fifth runtime.

**Not modified (intentionally):**
- `packages/core/*` — connectors are pure capability + runtime concerns; zero core changes.
- `packages/runtime-cron`, `packages/runtime-workflows` — out of band.
- `packages/registry/src/schema.ts` — connector config reuses the existing `CapabilityRefSchema.config` shape (`z.record(z.string(), z.unknown())`).

## Reused existing primitives

- `definePack` and `CapabilityPack` contract — `packages/registry/src/capability.ts:159`.
- `LocalToolHandler` shape — already used by `cap-filesystem` outbound tools; same path for `slack.send_message`.
- `enqueueRun` — `packages/runtime-worker/src/index.ts` (around line 267); connector handlers go through it.
- `assertCapabilityPack` and the dynamic-import loader — `packages/registry/src/capability.ts:188`; connector mount reuses both.
- `mountUiIfAvailable` pattern — `packages/web/src/ui-mount.ts`; `connector-mount.ts` mirrors it exactly.
- `installShutdownHandlers` — `packages/runtime-worker/src/index.ts`; relevant if v2 adds Socket Mode listeners.
- Conversations repo (`createConversation`, `loadConversation`, `findActiveRunForConversation`) — landed with the conversations work this plan rides on.

## Verification

**Unit tests:**
- `cap-slack/verify.test.ts` — known good signature passes; tampered body, expired timestamp, missing header all fail.
- `cap-slack/normalize.test.ts` — `url_verification` returns challenge; `app_mention` and `message` map correctly; bot_id messages and edits are skipped (unless `includeEdits`); unsupported event types return noop.
- `cap-slack/convid.test.ts` — deterministic id for same `(team, channel, thread_ts)`; differs across threads; stable across runs.
- `cap-webhook-generic/verify.test.ts` — GitHub-style HMAC validates; wrong prefix or algo fails.
- `cap-webhook-generic/extract.test.ts` — dotted path extraction; missing path returns full-body fallback.

**Integration tests** (requires `pnpm db:up` — postgres + valkey):
- `cap-slack/index.integration.test.ts`:
  - Send a webhook with `event_id=E1` twice → exactly one `agent_runs` row + one `agent_conversations` row.
  - Send a follow-up in same `thread_ts` → new run, same `conversation_id`, conversation history loads prior messages.
  - Send while a run is active → 202 returned, no second run enqueued.
- `packages/web/src/connector-mount.test.ts` — mount with a fake pack, hit `POST /connectors/<key>`, assert the contribution's webhook was invoked.

**Manual e2e** (after merge, on a staging service):
- Deploy `examples/support-agent` with `cap-slack` configured against a sandbox Slack workspace.
- DM the bot → bot replies via `slack.send_message` tool.
- Reply in thread → second turn lands in the same conversation; `GET /conversations/:id` shows both runs.
- Mention the bot in a channel → fresh conversation; reply in that thread continues it.
- Trigger a Slack retry (use Slack's "retry" debug feature) → no duplicate run.

**Commands:**
```sh
pnpm db:up
pnpm --filter @render-harness/cap-slack test
pnpm --filter @render-harness/cap-webhook-generic test
pnpm --filter @render-harness/web test -- connector
pnpm typecheck
pnpm build
```

## Execution order

1. **Confirm the conversation helper shape.** The underlying conversation model has landed; decide whether connectors call the primitives directly or use a small `enqueueIntoConversation(...)` wrapper.
2. **Registry contract.** Add `ConnectorContribution` to `packages/registry/src/capability.ts`. One commit. No callers yet.
3. **Web mount.** Add `connector-mount.ts`, `routes/connectors.ts`, wire into `serveWeb`. Tests with a fake pack.
4. **`cap-webhook-generic`.** Simpler of the two — no threading, no outbound tools. Validates the contract end-to-end.
5. **`cap-slack`.** Verify, normalize, convid, tools, full integration test against the running primitives stack.
6. **Docs.** `docs/connectors.md` (developer guide), CLAUDE.md addendum.
