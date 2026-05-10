import { serveWeb } from "@render-harness/web";
import { config as loadEnv } from "dotenv";
import { buildDemoAgent } from "./agent.js";

loadEnv({ quiet: true });

/**
 * Boots the multi-tenant web service with the operator UI mounted at /ui.
 * Pairs with `worker.ts` (or `dev.ts` to run both in one process). Visit
 * http://127.0.0.1:8080/ui/login and sign in with `WEB_API_KEY`.
 */
await serveWeb({
  agent: buildDemoAgent(),
  queue: process.env.WORKER_QUEUE ?? "operator-demo-runs",
  ui: true,
});
