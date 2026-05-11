# Plan: Chat-driven recurring agent runs + notifications

## Context

Today the harness supports scheduled runs only at deploy time: `render-harness.yaml` declares one Render Cron service per schedule (`packages/runtime-cron/`). There's no way to say "run the citations agent every weekday at 9am and post the summary to Slack" from inside a chat. There's also no `scheduled_runs` table, no notification channels, and no chat-callable scheduling tools.

We're adding a dynamic, in-process scheduling layer driven by chat. Schedules persist in Postgres; the always-on worker turns them into pg-boss cron jobs and dispatches results to Slack, generic webhooks, and an in-UI inbox. New core builtins (`schedule_run`, `list_schedules`, `cancel_schedule`, `update_schedule`, `list_scheduled_outputs`) let any agent — including the existing chat agent — manage schedules on the user's behalf.

The design deliberately reuses every existing seam:
- `enqueueRun()` to start each scheduled tick (no new run-creation path).
- `agent_runs.metadata.scheduleId` to tag scheduled invocations.
- The worker's existing `onJobResult` hook (`packages/runtime-worker/src/index.ts:76`) to dispatch notifications.
- The `listMyRuns` builtin pattern (`packages/core/src/builtins/listMyRuns.ts`) for new tools, hard-scoped to `ctx.userId`.

## Architecture decisions

1. **Schedules fire in-process via `pg-boss.schedule()`** inside the always-on worker. No Render Cron service per schedule.
2. **Channels v1:** Slack incoming webhook, generic outbound webhook, in-UI inbox. No email.
3. **Surface:** new core builtins. Any agent gets them via `buildBuiltinTools()`.
4. **Target:** schedules reference an existing agent by name + a fresh prompt + metadata. No conversation-resume in v1.
5. **Write path is DB-only from builtins.** Builtins run in the worker *or* web *or* cron process; only the worker holds the pg-boss handle that owns scheduling. Builtins write the DB row; the worker reconciles DB ↔ pg-boss on a 30s loop plus a Postgres `NOTIFY schedules_changed` for immediate sync.

## Implementation

### 1. Schema — new migration `packages/core/sql/0003_schedules.sql`

```sql
CREATE TABLE agent_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  agent_name      text NOT NULL,
  input           text NOT NULL,            -- prompt sent on each tick
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  cron_expr       text NOT NULL,
  timezone        text NOT NULL DEFAULT 'UTC',
  notifications   jsonb NOT NULL DEFAULT '[]'::jsonb,
                  -- [{kind:"slack",  target:"https://hooks.slack.com/..."},
                  --  {kind:"webhook",target:"https://example.com/agent"},
                  --  {kind:"inbox",  target:null}]
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_fired_at   timestamptz,
  next_fire_at    timestamptz
);
CREATE INDEX agent_schedules_user_idx ON agent_schedules(user_id, enabled);

CREATE TABLE schedule_runs (
  schedule_id  uuid REFERENCES agent_schedules(id) ON DELETE CASCADE,
  run_id       uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  fired_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, run_id)
);
CREATE INDEX schedule_runs_by_schedule ON schedule_runs(schedule_id, fired_at DESC);

CREATE TABLE notification_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  schedule_id   uuid REFERENCES agent_schedules(id) ON DELETE SET NULL,
  user_id       text NOT NULL,
  kind          text NOT NULL,             -- 'slack' | 'webhook' | 'inbox'
  target        text,
  summary       text NOT NULL,
  status        text NOT NULL,             -- 'delivered' | 'failed'
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notif_inbox_idx
  ON notification_deliveries(user_id, created_at DESC)
  WHERE kind = 'inbox';
```

Run by the existing `applyMigrations(pool)` (already invoked from worker boot at `packages/runtime-worker/src/index.ts:130`).

### 2. State repo — `packages/core/src/state/repo.ts` and `state/schema.ts`

Add types in `schema.ts`:
- `Schedule`, `NotificationConfig`, `NotificationDelivery`, `ScheduleRun`.

Add functions in `repo.ts` (mirror existing style, parameterized queries, return camelCase types):
- `createSchedule(pool, input): Promise<Schedule>` — also `pg_notify('schedules_changed', id::text)`.
- `listSchedules(pool, { userId, enabled? }): Promise<Schedule[]>`
- `getSchedule(pool, { id, userId }): Promise<Schedule | null>`
- `updateSchedule(pool, { id, userId, patch }): Promise<Schedule>` — NOTIFY on change.
- `setScheduleEnabled(pool, { id, userId, enabled }): Promise<void>` — NOTIFY.
- `deleteSchedule(pool, { id, userId }): Promise<void>` — NOTIFY.
- `recordScheduleRun(pool, { scheduleId, runId, firedAt })`
- `listScheduleRuns(pool, { scheduleId, limit })`
- `recordNotificationDelivery(pool, delivery)`
- `listInboxItems(pool, { userId, limit, beforeId? })` — joined view returning `{ scheduleId, scheduleName, runId, summary, status, runStatus, createdAt }`.

Export everything from `packages/core/src/index.ts`.

### 3. Builtin tools — `packages/core/src/builtins/`

Five new files, each following `listMyRuns.ts:16` (factory accepts `ctx`, returns `LocalToolHandler`, hard-scoped to `ctx.userId`).

- **`scheduleRun.ts` → `schedule_run`** — input `{ agentName: string, input: string, cron: string, timezone?: string, notifications?: NotificationConfig[], metadata?: object }`. Validates the cron expression with a small validator (add `cron-parser` to `packages/core/package.json`). Computes `nextFireAt`. Inserts via `createSchedule()`. Returns `{ scheduleId, nextFireAt, cron }`.
- **`listSchedules.ts` → `list_schedules`** — input `{ enabledOnly?: boolean }`. Returns concise multi-line summary.
- **`updateSchedule.ts` → `update_schedule`** — input `{ scheduleId, patch: { cron?, input?, notifications?, enabled?, metadata? } }`.
- **`cancelSchedule.ts` → `cancel_schedule`** — input `{ scheduleId }`. Soft-cancel (`enabled=false`) by default; `{ hard: true }` deletes.
- **`listScheduledOutputs.ts` → `list_scheduled_outputs`** — input `{ limit?, scheduleId? }`. The in-UI "inbox" backing read. Returns recent scheduled-run outputs with their last assistant message + delivery state.

Register all five in `packages/core/src/builtins/index.ts` so `buildBuiltinTools()` returns them. They become available to every agent, with per-agent opt-out via existing `permissions.deniedTools` / `permissions.allowedTools` (CLAUDE.md, "Built-in tools" section).

### 4. Worker: pg-boss schedule reconciler + notification dispatch

Modify `packages/runtime-worker/src/index.ts`:

**A. Reconciler.** After `boss.start()` (line 139), spawn a reconciliation task:
1. On boot and every 30s: load `SELECT id, cron_expr, timezone FROM agent_schedules WHERE enabled`. For each row call `boss.schedule(\`harness-sched-\${id}\`, cronExpr, { scheduleId: id }, { tz: timezone })` (pg-boss `schedule()` upserts by name — safe to call repeatedly).
2. For disabled/deleted IDs, call `boss.unschedule(name)`.
3. `LISTEN schedules_changed` on a dedicated PG client (mirror `state/repo.ts:19` for the pattern); on every notification, run the reconciler immediately (debounced 500ms).

**B. New queue handler.** Register a second pg-boss worker on queue `harness-scheduled-runs`. Handler reads `{ scheduleId }`, loads the schedule, then calls `enqueueRun(...)` against the existing `agent-runs` queue with:
- `agentName`, `userId` from the schedule
- `initialContent: [{ type: "text", text: schedule.input }]`
- `metadata: { scheduleId, fired_at, ...schedule.metadata }`

After enqueue, `recordScheduleRun(pool, { scheduleId, runId })` and update `last_fired_at` / `next_fire_at`. **Note:** pg-boss `schedule()` sends jobs to its own queue when fired, so we hook this queue into the scheduler via `boss.schedule(name, cron, data, { queue: 'harness-scheduled-runs' })`.

**C. Notification dispatch via `onJobResult`.** The current `WorkerOpts.onJobResult` (line 76) lets the caller pass a hook but no built-in one runs. Add a default hook (composable with user-supplied) that:
1. Reads `data.metadata.scheduleId`. If absent, skip.
2. Loads schedule + reads the last assistant text from `agent_messages` for `runId`.
3. For each entry in `schedule.notifications`:
   - `slack`: POST `{ text: summary, blocks: [...link to operator UI...] }` to the webhook URL.
   - `webhook`: POST `{ scheduleId, runId, status, summary, finishedAt, operatorUrl }` to the URL.
   - `inbox`: insert a row in `notification_deliveries` with `kind='inbox'`, `status='delivered'`. No network call.
4. Record every attempt in `notification_deliveries` (delivered/failed + error). Failures are logged and dropped — never re-enqueue runs over notification failure.

New module: `packages/core/src/notifications/` with `slack.ts`, `webhook.ts`, and a tiny `dispatch.ts` that the worker imports. Keep it in `core` so future runtimes (workflows, cron) can opt in.

### 5. Web HTTP read-only mirrors — `packages/web/src/routes/schedules.ts`

For the operator SPA at `/ui`. CRUD stays in the chat tools; HTTP is read-only:
- `GET /schedules` — list (uses cookie-session userId).
- `GET /schedules/:id/runs` — history with status + summary.
- `GET /inbox` — recent notification_deliveries with `kind='inbox'`.

Register the routes in `packages/web/src/index.ts` next to the existing `runs` mount.

### 6. UI — operator SPA in `packages/ui/`

Add one new page/tab "Scheduled tasks" that:
- Lists user's schedules (call to `/schedules`).
- Shows the inbox feed (`/inbox`), with a link to each run page.
- No edit/create UI in v1 — that flows through chat. (Toggle/cancel buttons can come later if the chat UX isn't enough.)

### 7. Contracts — `packages/contracts/src/index.ts`

Add wire types so UI + web + core share one source of truth:
- `Schedule`, `NotificationConfig`, `InboxItem`, `ScheduleHistoryItem`.

Per the recent refactor commits (`67cfcf6 feat(contracts): new @render-harness/contracts package for shared types`, `e0ed3fd refactor(web)...`), this is the established place for cross-package types.

## Files to add / modify

**New**
- `packages/core/sql/0003_schedules.sql`
- `packages/core/src/builtins/scheduleRun.ts`
- `packages/core/src/builtins/listSchedules.ts`
- `packages/core/src/builtins/updateSchedule.ts`
- `packages/core/src/builtins/cancelSchedule.ts`
- `packages/core/src/builtins/listScheduledOutputs.ts`
- `packages/core/src/notifications/{slack,webhook,dispatch,index}.ts`
- `packages/core/test/schedules.test.ts`
- `packages/core/test/builtins/scheduleRun.int.test.ts`
- `packages/web/src/routes/schedules.ts`
- `packages/ui/src/pages/ScheduledTasks.tsx` (or wherever the SPA's pages live)

**Modify**
- `packages/core/src/state/schema.ts` — add `Schedule`, `NotificationConfig`, `NotificationDelivery`, `ScheduleRun`.
- `packages/core/src/state/repo.ts` — CRUD functions + `pg_notify('schedules_changed', ...)`.
- `packages/core/src/builtins/index.ts` — register the five new factories.
- `packages/core/src/index.ts` — re-export schedule types + repo functions.
- `packages/core/package.json` — add `cron-parser` dependency.
- `packages/runtime-worker/src/index.ts` — reconciler, `harness-scheduled-runs` queue handler, default `onJobResult` notification dispatch.
- `packages/web/src/index.ts` — mount `/schedules` and `/inbox` routes.
- `packages/contracts/src/index.ts` — wire types.
- `packages/ui/src/...` — new page + nav entry.

## Verification

**Unit (`pnpm --filter @render-harness/core test`)**
- `schedules.test.ts`: createSchedule → listSchedules round-trip; `pg_notify` fires on insert/update/delete (use the test KV/PG harness from existing tests); cron-expression validation rejects junk; `cancelSchedule` soft + hard paths.
- `scheduleRun.int.test.ts`: invokes the `schedule_run` builtin handler with a fixed `ctx.userId`; asserts a row appears and `userId` isolation holds (cross-tenant read returns nothing).

**Integration**
- Add `packages/runtime-worker/test/reconciler.int.test.ts`: insert a schedule with cron `* * * * *`, boot the worker (pointed at the local stack from `pnpm db:up`), wait ~75s, assert (a) a new row in `agent_runs` with `metadata.scheduleId` set, (b) a row in `schedule_runs`. Skip with `describe.skipIf(!process.env.HARNESS_RUN_INTEGRATION)` so it doesn't run by default.

**Manual end-to-end**
1. `pnpm db:up && pnpm build`
2. `pnpm dev:operator-worker` (in one shell) + `pnpm dev:operator-web` (in another).
3. Open `/ui`, start a chat against the existing operator agent.
4. Ask: *"Schedule a daily 9am UTC run of the citations-monitor agent. Post the summary to this Slack webhook: <url>."* → expect a tool call to `schedule_run` and a confirmation with `scheduleId` + next fire time.
5. For a faster manual check: ask the agent to schedule with cron `* * * * *` and `notifications: [{kind:"inbox"}]`. Wait ~60s. Ask: *"What's in my inbox?"* → expect a tool call to `list_scheduled_outputs` returning the new entry. The `/ui` "Scheduled tasks" tab should show the same row.
6. Slack: point at a real incoming webhook (or `https://webhook.site/<id>` for the generic webhook test). Verify both arrive.
7. Cancel: *"Cancel that schedule."* → row flips to `enabled=false`, pg-boss reconciler unschedules within 30s (or instantly via NOTIFY).

**Lint/type/test gates**
- `pnpm check` (Biome — watch for `noConsole` in non-script files, `noUnusedImports`, `useImportType`).
- `pnpm typecheck`
- `pnpm test`
