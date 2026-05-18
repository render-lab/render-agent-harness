-- Render agent harness — per-end-user OAuth connections.
--
-- The connection API: each end user clicks "Connect <provider>" in the
-- operator UI, the harness exchanges Google/Microsoft/etc.'s OAuth code
-- for tokens and stores them here, encrypted-at-rest, keyed by
-- (user_id, provider). Tools call `SecretsContext.requireConnection`
-- inside their handler to get a fresh access token at call time.
--
-- Refresh tokens AND access tokens are encrypted together as one
-- ciphertext blob. The blob's plaintext shape is:
--   { accessToken, refreshToken, expiresAt, scopes, accountLabel }
-- The platform refreshes on use and atomically re-encrypts.
--
-- Multi-tenant safety: rows are isolated by `user_id`; the SecretsContext
-- built per tool invocation closes over the run's `user_id` and queries
-- with WHERE user_id = $1 only. There is no path for a tool to read
-- another tenant's connections.

CREATE TABLE IF NOT EXISTS agent_user_connections (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    scopes        TEXT[] NOT NULL DEFAULT '{}',
    -- User-facing label (e.g. their Gmail address) for the "Connected as
    -- foo@example.com" UI affordance. Best-effort; the optional
    -- `fetchAccountLabel` provider hook populates it.
    account_label TEXT,
    -- AES-256-GCM ciphertext over the JSON-encoded token bundle.
    ciphertext    BYTEA NOT NULL,
    -- 12-byte IV; required for AES-GCM decryption.
    iv            BYTEA NOT NULL,
    -- 16-byte auth tag; required for AES-GCM verify.
    auth_tag      BYTEA NOT NULL,
    -- Future-proof: when CONNECTIONS_ENCRYPTION_KEY rotates, rows
    -- carry their key version so a rotation script can re-encrypt
    -- without taking the registry down.
    key_version   INT NOT NULL DEFAULT 1,
    -- Denormalized access-token expiry so `refreshIfNeeded` doesn't have
    -- to decrypt every row on every tool call to check "is this still
    -- fresh?". Updated atomically with the ciphertext on refresh.
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS agent_user_connections_user_idx
    ON agent_user_connections(user_id);
