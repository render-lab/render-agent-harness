import type { Logger } from "./logger.js";

export interface ShutdownOpts {
  /** Process exit code on clean shutdown. Default 0. */
  exitCode?: number;
  /**
   * Hard cap before forced exit, in ms. Prevents a stuck stop() from holding
   * the process past Render's SIGTERM grace period (30s for web/worker).
   * Default 10_000.
   */
  forceExitAfterMs?: number;
  /** Service name in the log line ("shutting down ${service}"). */
  service?: string;
}

/**
 * Install SIGTERM/SIGINT handlers that call `stop()` and exit. Listens once
 * per signal — only the first signal triggers stop(); subsequent signals are
 * ignored so stop() can't run twice. A hard `setTimeout` cap forces exit if
 * stop() hangs.
 */
export function installShutdownHandlers(
  stop: () => Promise<void> | void,
  logger: Logger,
  opts: ShutdownOpts = {},
): void {
  const exitCode = opts.exitCode ?? 0;
  const forceMs = opts.forceExitAfterMs ?? 10_000;
  const service = opts.service ?? "service";
  const handler = async (signal: NodeJS.Signals) => {
    logger.warn({ signal }, `shutting down ${service}`);
    setTimeout(() => process.exit(exitCode), forceMs).unref();
    try {
      await stop();
      process.exit(exitCode);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "shutdown errored");
      process.exit(1);
    }
  };
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}
