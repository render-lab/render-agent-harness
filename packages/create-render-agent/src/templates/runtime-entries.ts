import type { Answers, RuntimeSelection } from "../types.js";

/**
 * Returns the file body for a runtime entrypoint. The shape mirrors what
 * each runtime expects:
 *
 *   - web (no UI) → `serveAgent({ agent })` from `@render-harness/runtime-web`
 *   - web + UI    → `serveWeb({ agent, ui: true })` from `@render-harness/web`
 *                   (drains via a paired worker runtime)
 *   - cron        → `runCronAndExit({ agent, logger })` from `@render-harness/runtime-cron`
 *   - worker      → `startWorkerAndWait({ agent, queue, logger })` from `@render-harness/runtime-worker`
 *
 * Each entry imports the agent from `../agent/index.js`, which works
 * whether the entry lives at `src/main.ts` (single-runtime) or
 * `src/<kind>.ts` (multi-runtime).
 */
export function runtimeEntry(runtime: RuntimeSelection, answers: Answers): string {
  switch (runtime.kind) {
    case "web":
      return answers.ui ? webEntryWithUi(answers) : webEntry();
    case "cron":
      return cronEntry();
    case "worker":
      return workerEntry(runtime.queue);
  }
}

function webEntry(): string {
  return `/**
 * Web runtime entrypoint. Hands the agent to runtime-web's serveAgent(),
 * which boots an HTTP server that accepts run requests and streams results.
 */

import { serveAgent } from "@render-harness/runtime-web";
import { agent } from "../agent/index.js";

await serveAgent({ agent });
`;
}

function webEntryWithUi(answers: Answers): string {
  // Find the worker queue so the web service enqueues onto the same one
  // the paired worker drains. The wizard guarantees a worker runtime
  // exists whenever ui is true.
  const worker = answers.runtimes.find((r) => r.kind === "worker");
  const defaultQueue = worker && worker.kind === "worker" ? worker.queue : "agent-runs";
  return `/**
 * Web runtime entrypoint with the operator UI mounted at /ui.
 *
 * serveWeb() pairs with a worker runtime: HTTP requests enqueue jobs on
 * the pg-boss queue, the worker drains them, and the UI streams progress
 * back via Server-Sent Events.
 *
 * Visit http://127.0.0.1:8080/ui/login and sign in with WEB_API_KEY.
 */

import { serveWeb } from "@render-harness/web";
import { config as loadEnv } from "dotenv";
import { agent } from "../agent/index.js";

loadEnv({ quiet: true });

await serveWeb({
  agent,
  queue: process.env.WORKER_QUEUE ?? ${JSON.stringify(defaultQueue)},
  ui: true,
});
`;
}

function cronEntry(): string {
  return `/**
 * Cron runtime entrypoint. Render schedules this process per the
 * \`runtimes[].schedule\` cron expression in render-harness.yaml. The
 * runtime owns wall-time budget (defaults to 11h to fit the 12h platform
 * cap) and migrations.
 */

import { applyMigrations, buildLogger, getPool } from "@render-harness/core";
import { runCronAndExit } from "@render-harness/runtime-cron";
import { config as loadEnv } from "dotenv";
import { agent } from "../agent/index.js";

loadEnv({ quiet: true });

async function main(): Promise<void> {
  const logger = buildLogger({ service: agent.name });
  const pool = getPool({ applicationName: agent.name });
  await applyMigrations(pool);

  await runCronAndExit({
    agent,
    logger,
    skipMigrations: true,
    metadata: { source: "render-cron" },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
`;
}

function workerEntry(defaultQueue: string): string {
  return `/**
 * Worker runtime entrypoint. Consumes run jobs off the pg-boss queue
 * configured in render-harness.yaml. Reads WORKER_QUEUE for overrides;
 * the literal default below mirrors the queue declared in YAML.
 */

import { applyMigrations, buildLogger, getPool } from "@render-harness/core";
import { startWorkerAndWait } from "@render-harness/runtime-worker";
import { config as loadEnv } from "dotenv";
import { agent } from "../agent/index.js";

loadEnv({ quiet: true });

async function main(): Promise<void> {
  const logger = buildLogger({ service: agent.name });
  const pool = getPool({ applicationName: agent.name });
  await applyMigrations(pool);

  const queue = process.env.WORKER_QUEUE ?? ${JSON.stringify(defaultQueue)};

  await startWorkerAndWait({
    agent,
    queue,
    logger,
    skipMigrations: true,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
`;
}
