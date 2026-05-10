import type { SerializedError } from "./types.js";

/**
 * Best-effort serialization of an arbitrary thrown value into the
 * `SerializedError` shape that `agent_runs.final_error` and `RunStepResult`
 * expect. Falls back gracefully when the throw isn't an Error instance.
 *
 * Picks up `err.code` when present (Postgres / SDK errors commonly set it).
 */
export function serializeError(err: unknown, fallbackName = "UnknownError"): SerializedError {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return {
      name: err.name,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { name: fallbackName, message: String(err) };
}
