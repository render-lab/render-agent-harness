-- Pack-level migration tracking. Capability packs can declare SQL
-- migrations via the `migrations` slot on the CapabilityPack contract;
-- the runtime applies any unapplied ones at boot via
-- `applyMigrations(pool, { packMigrations })`. This table records what
-- has been applied so the runner can skip already-applied migrations on
-- subsequent boots and surface them in audit queries.

CREATE TABLE IF NOT EXISTS agent_pack_migrations (
  pack_name text NOT NULL,
  migration_id text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_name, migration_id)
);
