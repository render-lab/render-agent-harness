import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, buildLogger, getPool } from "@render-harness/core";
import { runCronAndExit } from "@render-harness/runtime-cron";
import { config as loadEnv } from "dotenv";
import { buildCitationsAgent } from "./agent.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Local dev: load .env if present. In production (Render cron), env vars come
// from the service config and dotenv is a no-op.
loadEnv({ path: join(HERE, "..", ".env"), quiet: true });

async function main(): Promise<void> {
  const logger = buildLogger({ service: "citations-monitor" });
  const pool = getPool({ applicationName: "citations-monitor" });

  // Apply harness migrations + this example's migrations on every boot.
  // Idempotent — costs ~10 ms when there's nothing to do.
  await applyMigrations(pool);
  await pool.query(readFileSync(join(HERE, "..", "sql", "0001_init.sql"), "utf8"));
  logger.info("migrations applied");

  const agent = buildCitationsAgent({ pool });

  await runCronAndExit({
    agent,
    logger,
    skipMigrations: true,
    metadata: { source: "render-cron" },
  });
}

main().catch((err) => {
  // Last-resort handler — runCronAndExit normally swallows and exits, so we
  // only reach here for boot-time failures (e.g. missing DATABASE_URL).
  console.error(err);
  process.exit(2);
});
