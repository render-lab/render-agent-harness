import { createRequire } from "node:module";
import { type Logger, pino } from "pino";

/**
 * Build the harness's default structured logger. Renders pretty in dev (when
 * `NODE_ENV !== "production"` and pino-pretty resolves), JSON otherwise.
 *
 * Every log line carries the `service` field; runtimes child this with
 * `runId`, `agent`, `tool`, etc. for traceability across the run.
 */
export function buildLogger(opts?: { service?: string; level?: string }): Logger {
  const isProd = process.env.NODE_ENV === "production";
  const level = opts?.level ?? process.env.LOG_LEVEL ?? "info";
  const usePretty = !isProd && hasPinoPretty();
  return pino({
    level,
    base: { service: opts?.service ?? "render-harness" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(usePretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, singleLine: false },
          },
        }
      : {}),
  });
}

/**
 * Probe whether pino-pretty can be resolved from this module. We do this
 * synchronously up front so we can fall back to JSON output instead of
 * crashing in pino's worker thread when the transport isn't installed.
 */
function hasPinoPretty(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export type { Logger };
