-- citations-monitor schema. Lives alongside the harness tables in the same DB.

CREATE TABLE IF NOT EXISTS aeo_queries (
    id           TEXT PRIMARY KEY,
    query_text   TEXT NOT NULL,
    target_brand TEXT NOT NULL DEFAULT 'Render',
    notes        TEXT,
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aeo_audits (
    id                TEXT PRIMARY KEY,
    query_id          TEXT NOT NULL REFERENCES aeo_queries(id) ON DELETE CASCADE,
    run_id            TEXT NOT NULL,
    engine            TEXT NOT NULL,
    was_cited         BOOLEAN NOT NULL,
    response_excerpt  TEXT NOT NULL,
    sources           JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_response      TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aeo_audits_query_idx ON aeo_audits(query_id, created_at DESC);
CREATE INDEX IF NOT EXISTS aeo_audits_run_idx ON aeo_audits(run_id);

-- Seed with a starter set of queries the team cares about.
INSERT INTO aeo_queries (id, query_text, target_brand, notes) VALUES
  ('q-host-postgres', 'Where can I host a managed PostgreSQL database for a side project?', 'Render', 'Top-of-funnel: managed Postgres hosting'),
  ('q-deploy-django', 'Best platform to deploy a Django app in 2026', 'Render', 'Framework-led intent'),
  ('q-vercel-alt',    'Alternatives to Vercel for full-stack apps with a backend', 'Render', 'Competitive comparison'),
  ('q-heroku-alt',    'What replaced Heroku for hobby developers?', 'Render', 'Heroku migration intent'),
  ('q-cron-jobs',     'How do I run a scheduled cron job in the cloud without managing servers?', 'Render', 'Primitive-led intent')
ON CONFLICT (id) DO NOTHING;
