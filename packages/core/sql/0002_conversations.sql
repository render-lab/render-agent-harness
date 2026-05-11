-- Render agent harness — conversations.
-- Groups many runs into one ongoing thread. A conversation is created up
-- front; each user turn enqueues a new run that ends in a terminal state
-- (`completed`, `failed`, `cancelled`). The model loads message history
-- across all runs in the conversation via the denormalised
-- `agent_messages.conversation_id` column, so the loop never joins.
--
-- Sequential-only: at most one active (pending|running|paused) run per
-- conversation, enforced by `agent_runs_conversation_active_uq`. Concurrent
-- / interleaved turns are out of scope.

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
    ADD COLUMN IF NOT EXISTS conversation_id TEXT
        REFERENCES agent_conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS agent_runs_conversation_idx
    ON agent_runs(conversation_id, created_at)
    WHERE conversation_id IS NOT NULL;

-- Sequential-only invariant: at most one non-terminal run per conversation.
-- POST /conversations/:id/messages returns 409 when this would be violated.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_conversation_active_uq
    ON agent_runs(conversation_id)
    WHERE conversation_id IS NOT NULL
      AND status IN ('pending','running','paused');

ALTER TABLE agent_messages
    ADD COLUMN IF NOT EXISTS conversation_id TEXT
        REFERENCES agent_conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS agent_messages_conversation_idx
    ON agent_messages(conversation_id, created_at)
    WHERE conversation_id IS NOT NULL;
