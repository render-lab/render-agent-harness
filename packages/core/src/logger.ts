import { type Logger, pino } from "pino";

/**
 * Build the harness's default structured logger. Renders pretty in dev (when
 * `NODE_ENV !== "production"` and pino-pretty is installed), JSON in prod.
 *
 * Every log line carries the `service` field; runtimes child this with
 * `runId`, `agent`, `tool`, etc. for traceability across the run.
 */
export function buildLogger(opts?: { service?: string; level?: string }): Logger {
  const isProd = process.env.NODE_ENV === "production";
  const level = opts?.level ?? process.env.LOG_LEVEL ?? "info";
  return pino({
    level,
    base: { service: opts?.service ?? "render-harness" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isProd
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, singleLine: false },
          },
        }),
  });
}

export type { Logger };
