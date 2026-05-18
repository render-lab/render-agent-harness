-- Wizard service schema. Tracks GitHub-authenticated users and which
-- managed-org repos belong to them. The wizard's mutation routes (POST
-- /api/agents/add, POST /api/capabilities/install) consult this table
-- to authorize session-cookie requests; bearer-secret requests bypass
-- ownership because the deployed harness's proxy already proves it.

CREATE TABLE IF NOT EXISTS wizard_users (
    github_user_id  BIGINT PRIMARY KEY,
    login           TEXT NOT NULL,
    name            TEXT,
    avatar_url      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wizard_user_repos (
    github_user_id   BIGINT NOT NULL REFERENCES wizard_users(github_user_id),
    org              TEXT NOT NULL,
    repo             TEXT NOT NULL,
    installation_id  TEXT NOT NULL,
    agent_slug       TEXT,
    role             TEXT NOT NULL DEFAULT 'owner',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (github_user_id, org, repo)
);

CREATE INDEX IF NOT EXISTS wizard_user_repos_by_user_idx
    ON wizard_user_repos (github_user_id, created_at DESC);
