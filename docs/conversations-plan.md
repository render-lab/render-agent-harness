# Plan: first-class conversations, drop chat-shape overload

Status: implemented. The migration, repo helpers, loop changes, web routes, streaming, and UI chat wiring have landed. This document remains as design history and a follow-up backlog.

This document captures the plan to evolve the current chat mechanism — *one chat = one long-lived run, each turn pauses* — into a proper `conversations` model where many runs belong to one conversation. The trigger is the load-bearing-but-fragile design noted in [`ui-guide.md`](ui-guide.md): the `paused` state is doing two unrelated jobs (HITL approval + chat-turn-end), and there's no first-class home for list-of-sessions, per-conversation cost rollups, or branching.

## Previous state, in one paragraph

A chat-shape agent (`shape: "chat"` in `defineAgent()`) ends each turn in `paused` with `metadata.pauseReason = "chat_turn_end"` instead of `completed`. The Chat tab keeps the same `runId` across page refreshes. New user messages go through `POST /runs/:id/input`, which sets the run back to `pending` and re-enqueues it. The next iteration loads full history from `agent_messages WHERE run_id = ?` and feeds it to the model. There is no `conversations` table; one chat session is exactly one row in `agent_runs`.

## Target state

- One run = one tool-loop unit. Always ends in a terminal state (`completed`, `failed`, `cancelled`).
- `paused` means *only* "I need a human" — `ask_user`, `permissions.requireApproval`. Chat-turn-end is no longer a reason to pause.
- `conversations` is a first-class entity that groups runs. The model loads history across the conversation; runs come and go inside it.
- Streaming works at both layers: per-run (existing SSE) and per-conversation (fans in across the conversation's runs).
- Frontend leans on `@assistant-ui/react`'s thread-list runtime — one thread maps 1:1 to one conversation, and we get the sidebar / switcher / new-chat button without writing list UI.
- `shape: "chat"` is deleted. Multi-turn vs single-turn is expressed by *whether the run was created with a `conversationId`*, not by an agent-level flag.

## Design decisions

1. **`conversation_id` is nullable** on both `agent_runs` and `agent_messages`. A conversation only exists when there's actually a sequence to track. Cron one-shots and single-turn web hits don't synthesize singleton conversations — that would pad the table with rows nobody looks at. The cost is `LEFT JOIN` in queries that surface conversation context for runs; cheap and honest.
2. **`conversation_id` is denormalized onto `agent_messages`.** It's redundant with `agent_runs.conversation_id`, but it lets the loop's history load do `WHERE conversation_id = ? ORDER BY created_at` without joining runs. The cost is keeping the two columns consistent — enforced by always setting them in the same insert path.
3. **Sequential runs only**, per conversation, for now. `POST /conversations/:id/messages` returns `409` if the conversation has an active (non-terminal) run. Concurrent / interleaved turns are out of scope; revisit if a real use case shows up.
4. **NOTIFY payload gains `conversationId`.** The streaming protocol stays "pointers over NOTIFY, full row read from `agent_messages`," but the pointer now includes the conversation id so the web layer can fan in with a single LISTEN. Still well under the 8 KB cap.
5. **No new dependencies.** Vercel AI SDK persistence patterns are useful as a reference, but importing the SDK conflicts with locked decision #2 (no agent framework). Backend stays hand-rolled; frontend leverage comes from `@assistant-ui/react`, which is already a dep.
6. **`POST /runs/:id/input` reverts to a pure HITL primitive.** It is no longer the chat-resume path. Anything that was using it for chat moves to `POST /conversations/:id/messages`.

## Schema

New migration: `packages/core/sql/0002_conversations.sql`.

```sql
CREATE TABLE IF NOT EXISTS agent_conversations (
    id              TEXT PRIMARY KEY,
    user_id         TEXT,
    agent_name      TEXT NOT NULL,
    agent_version   TEXT NOT NULL,
    title           TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    total_cost_usd  NUMERIC(12,6) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_conversations_user_idx
    ON agent_conversations(user_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS agent_conversations_agent_idx
    ON agent_conversations(agent_name, last_active_at DESC);

ALTER TABLE agent_runs
    ADD COLUMN conversation_id TEXT
        REFERENCES agent_conversations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agent_runs_conversation_idx
    ON agent_runs(conversation_id, created_at)
    WHERE conversation_id IS NOT NULL;

ALTER TABLE agent_messages
    ADD COLUMN conversation_id TEXT
        REFERENCES agent_conversations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agent_messages_conversation_idx
    ON agent_messages(conversation_id, created_at)
    WHERE conversation_id IS NOT NULL;

-- Enforce: at most one active run per conversation. Sequential-only invariant.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_conversation_active_uq
    ON agent_runs(conversation_id)
    WHERE conversation_id IS NOT NULL
      AND status IN ('pending','running','paused');
```

Tables are namespaced `agent_*` to match the existing schema.

## Core (`@render-harness/core`)

### Types — `packages/core/src/types.ts`

- Remove `shape?: "chat" | "single-turn"` from `AgentDefinition`. Likewise the `shape !== undefined` validation in `defineAgent`.
- Add `ConversationId = string`.
- Add `AgentConversation { id, userId?, agentName, agentVersion, title?, metadata, totalCostUsd, createdAt, updatedAt, lastActiveAt }`.
- `AgentRun.conversationId?: ConversationId` (optional).

### Loop — `packages/core/src/loop.ts`

- Delete the `chat_turn_end` branch that ends a turn in `paused`. Replace with the original `completed` terminal write.
- `RunAgentArgs` already has `runId`; the conversation linkage lives on the row, not the args. The loop reads `run.conversationId` (loaded via `loadRun`) to decide whether to load history per-run or per-conversation:
  ```ts
  const messages = run.conversationId
    ? await loadConversationMessages(pool, run.conversationId)
    : await listMessages(pool, runId);
  ```
- On every persisted assistant message, also write `conversation_id` (mirrors `run.conversationId`) so the partial index is populated.
- After a run reaches a terminal state (`completed | failed | cancelled`), if `run.conversationId` is set, update the conversation: `last_active_at = now()`, `total_cost_usd += run.total_cost_usd`. Same transaction as the final `setRunStatus`.

### Repo — `packages/core/src/state/repo.ts`

New functions, exported from `index.ts`:

```ts
createConversation(pool, { id?, userId?, agentName, agentVersion, title?, metadata? }): Promise<AgentConversation>
loadConversation(pool, id): Promise<AgentConversation | null>
listConversations(pool, filter): Promise<ListConversationsPage>     // keyset on last_active_at
loadConversationMessages(pool, conversationId): Promise<Message[]>  // ORDER BY created_at, seq
findActiveRunForConversation(pool, conversationId): Promise<AgentRun | null> // for the 409 guard
rollupConversation(pool, conversationId, deltaCostUsd): Promise<void>
```

`createRun(...)` gains an optional `conversationId` parameter; when set, it's written to the run row.

### Tests

- Existing `cancel`, `idempotency`, `prompt`, `truncate`, `cost` tests stay valid — they don't touch chat-shape.
- New tests:
  - `conversations.test.ts` — create/list/load round-trip, rollup math.
  - `loop.test.ts` extension — run with `conversationId` set replays prior messages from the conversation, ends `completed`.
  - Sequential-only test — second `createRun` with the same `conversationId` while the first is `running` violates the unique partial index → `repo` surfaces a typed `ActiveRunExists` error.
- Delete: any test exercising the `chat_turn_end` paused branch.

## Web (`@render-harness/web`)

### New routes

| Route | Purpose |
|---|---|
| `POST /conversations` | Create. Body: `{ agentName?, userId?, title? }`. Defaults to the service's loaded agent. Returns `{ id, ... }`. Does not enqueue a run. |
| `GET /conversations` | List, keyset on `last_active_at`. Filters: `userId`, `agentName`, `q` (title search; cheap `ILIKE` for now, `pg_trgm` later). |
| `GET /conversations/:id` | Single conversation with embedded run summaries (last N runs + counts). |
| `POST /conversations/:id/messages` | Append a user message and enqueue a new run with `conversation_id` set. `409` if there's an active run on this conversation. Body matches the existing `POST /runs` shape. |
| `GET /conversations/:id/stream` | SSE. Subscribes to `agent_runs` LISTEN channel and forwards events whose pointer carries the matching `conversationId`. |

### Existing routes

- `POST /runs/:id/input` — body unchanged; semantics narrow to HITL only. Emit a `400` if called against a run whose pause reason is anything other than HITL (which after this change means: nothing else triggers `paused`). Update the OpenAPI / handler doc comments accordingly.
- `POST /runs`, `GET /runs/:id`, `GET /runs/:id/stream`, `POST /runs/:id/cancel`, `GET /runs`, `GET /agents`, `GET /usage` unchanged.

### Streaming protocol change

Producer side (the loop's `NOTIFY` call): payload becomes `{ runId, messageId, kind, conversationId? }`. Consumer side: `GET /conversations/:id/stream` filters by `conversationId`, the existing `GET /runs/:id/stream` filter logic adds the new field as a no-op. One LISTEN channel, two views.

## UI (`@render-harness/ui`)

- Map one `@assistant-ui/react` thread to one `conversationId`. Use the library's thread-list runtime adapter so the sidebar, switcher, and new-chat button come for free.
- Chat tab routes:
  - `/ui/chat` → list with "New chat" CTA.
  - `/ui/chat/:conversationId` → focused thread view; SSE subscribes to `GET /conversations/:id/stream`.
  - "New chat" → `POST /conversations` → redirect to `/ui/chat/:newId`.
  - Send message → `POST /conversations/:id/messages`. Stop → `POST /runs/:activeRunId/cancel`.
- Runs tab: existing list gains a `conversation` link column when `conversation_id` is set.
- Delete the existing single-run chat plumbing that used `POST /runs/:id/input`.

## Docs

- [`docs/architecture.md`](architecture.md) — add a "Conversations" section under State model. Note `conversation_id` on runs and messages, and the sequential-only invariant.
- [`docs/ui-guide.md`](ui-guide.md) — replace the "Chat shape" section. New explanation: chat is `POST /conversations` then `POST /conversations/:id/messages`; nothing about `shape: "chat"` or paused-turn-ends. Update the "What it deliberately doesn't do" list — list-of-past-sessions and per-conversation rollups are no longer explicit non-goals.
- README — chat-shape language refreshed to reference conversations.

## Out of scope (follow-ups)

Tracked here so the boundary is explicit:

- **Auto-generated titles.** Cheap follow-up: after the first assistant turn completes, run a one-shot summarization to set `title`. Add an env-gated builtin or a tiny background job.
- **Per-conversation usage rollups in `GET /usage`.** The data is already there (`total_cost_usd` on `agent_conversations`); UI surfaces it.
- **Branching.** `POST /conversations/:id/fork-at-run/:runId` copies messages up to the fork point into a new conversation. Trivial once the model is conversation-keyed.
- **Conversation deletion / archival.** `DELETE /conversations/:id` cascades via FK; need soft-delete UX in the UI.
- **Concurrent runs per conversation.** Drop the unique partial index, define interleaving semantics. Likely not worth doing without a concrete use case.

## Open questions

- **Soft-delete vs hard-delete** for conversations. Cascade FKs make hard-delete one statement; soft-delete preserves history but requires every list query to filter. Default to hard-delete unless an audit requirement shows up.
- **Conversation ownership across `agentName` changes.** If a deployed agent's `name`/`version` changes, do existing conversations still belong to it, or do they become orphaned? Lean toward "the conversation row records the agent at creation time; mismatched future deploys can still continue the conversation." Decide at implementation time.
- **HITL inside a conversation.** When `ask_user` pauses a run mid-conversation, the conversation is "blocked" until `POST /runs/:id/input` resolves it. UI needs to surface a pending-input affordance on the thread. Mechanically nothing new — the run lifecycle already handles it — but the UI affordance is new work.

## Execution order

Single milestone since there's no compat to preserve. Suggested commit boundaries:

1. **Schema + repo.** `0002_conversations.sql`, new repo functions, types, exports. No callers yet.
2. **Loop.** Drop `shape: "chat"`, drop the `chat_turn_end` branch, wire `conversationId` history load and rollup. Update tests; delete obsolete ones.
3. **Web.** New conversation routes; narrow `/runs/:id/input`; extend NOTIFY payload and SSE filter.
4. **UI.** Rewire Chat tab onto assistant-ui thread-list + conversation routes. Delete old chat plumbing.
5. **Docs.** Update `architecture.md`, `ui-guide.md`, README. Delete this plan or move it under an `archive/` if we want a record.
