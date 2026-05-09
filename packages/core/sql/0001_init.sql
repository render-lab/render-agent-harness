-- Render agent harness — initial schema.
-- Owns "what the work produced": runs, messages, tool calls, full results.

CREATE TABLE IF NOT EXISTS agent_runs (
    id              TEXT PRIMARY KEY,
    agent_name      TEXT NOT NULL,
    agent_version   TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending','running','paused','completed','failed','cancelled')),
    user_id         TEXT,
    cursor          JSONB NOT NULL DEFAULT '{"turn":0,"toolCalls":0,"wallMs":0,"usage":{"inputTokens":0,"outputTokens":0}}'::jsonb,
    total_cost_usd  NUMERIC(12,6) NOT NULL DEFAULT 0,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    final_error     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON agent_runs(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs(status) WHERE status IN ('pending','running','paused');

CREATE TABLE IF NOT EXISTS agent_messages (
    id             TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    content        JSONB NOT NULL,
    usage          JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_run_seq_uq ON agent_messages(run_id, seq);
CREATE INDEX IF NOT EXISTS agent_messages_run_idx ON agent_messages(run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
    id                TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    input             JSONB NOT NULL,
    idempotency_key   TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_tool_calls_idem_uq ON agent_tool_calls(run_id, idempotency_key);
CREATE INDEX IF NOT EXISTS agent_tool_calls_run_idx ON agent_tool_calls(run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_tool_results (
    tool_call_id     TEXT PRIMARY KEY REFERENCES agent_tool_calls(id) ON DELETE CASCADE,
    run_id           TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    content          TEXT NOT NULL,
    truncated_content TEXT NOT NULL,
    token_count      INTEGER NOT NULL,
    is_error         BOOLEAN NOT NULL DEFAULT false,
    duration_ms      INTEGER NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_tool_results_run_idx ON agent_tool_results(run_id);

-- Atomic seq allocation per run; called inside the same transaction as the
-- message insert.
CREATE OR REPLACE FUNCTION agent_next_seq(p_run_id TEXT) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    next_seq INTEGER;
BEGIN
    SELECT COALESCE(MAX(seq), 0) + 1 INTO next_seq
    FROM agent_messages
    WHERE run_id = p_run_id;
    RETURN next_seq;
END;
$$;
