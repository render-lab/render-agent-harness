-- Render agent harness — dynamic scheduled runs and notifications.

CREATE TABLE IF NOT EXISTS agent_schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL,
    agent_name      TEXT NOT NULL,
    input           TEXT NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    cron_expr       TEXT NOT NULL,
    timezone        TEXT NOT NULL DEFAULT 'UTC',
    notifications   JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_fired_at   TIMESTAMPTZ,
    next_fire_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_schedules_user_idx
    ON agent_schedules(user_id, enabled);

CREATE TABLE IF NOT EXISTS schedule_runs (
    schedule_id  UUID REFERENCES agent_schedules(id) ON DELETE CASCADE,
    run_id       TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
    fired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (schedule_id, run_id)
);

CREATE INDEX IF NOT EXISTS schedule_runs_by_schedule
    ON schedule_runs(schedule_id, fired_at DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    schedule_id   UUID REFERENCES agent_schedules(id) ON DELETE SET NULL,
    user_id       TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('slack','webhook','inbox')),
    target        TEXT,
    summary       TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('delivered','failed')),
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_deliveries_inbox_idx
    ON notification_deliveries(user_id, created_at DESC)
    WHERE kind = 'inbox';

CREATE INDEX IF NOT EXISTS notification_deliveries_schedule_idx
    ON notification_deliveries(schedule_id, created_at DESC)
    WHERE schedule_id IS NOT NULL;
