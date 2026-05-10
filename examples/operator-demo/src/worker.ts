import { startWorkerAndWait } from "@render-harness/runtime-worker";
import { config as loadEnv } from "dotenv";
import { buildDemoAgent } from "./agent.js";

loadEnv({ quiet: true });

/**
 * Worker companion to `web.ts`. Pulls run jobs from the queue and runs
 * each through the demo agent. Without this process, runs enqueued by
 * the web service sit in `agent_runs` at status="pending" — visible in
 * the UI but never advancing.
 */
await startWorkerAndWait({
  agent: buildDemoAgent(),
  queue: process.env.WORKER_QUEUE ?? "operator-demo-runs",
});
