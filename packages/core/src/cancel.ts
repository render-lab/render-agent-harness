import type { RunId } from "./types.js";

/**
 * Cancellation lives in Key Value (Redis-compatible). The web service writes
 * `cancel:{runId}` with a TTL; the core polls the flag at three boundaries:
 *
 *   1. Before each model call.
 *   2. Before each tool dispatch.
 *   3. Between tool result append and the next model call.
 *
 * The runtime supplies an {@link AbortSignal} via {@link createCancelSignal} so
 * in-flight HTTP requests (model + MCP) abort cleanly when the flag flips.
 */

export interface KvLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: "EX", ttlSeconds?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function cancelKey(runId: RunId): string {
  return `cancel:${runId}`;
}

/**
 * Build an AbortController whose signal aborts when either:
 *   - the upstream signal aborts (runtime-driven shutdown), or
 *   - the KV cancel flag is set for this run.
 *
 * The poll interval defaults to 500 ms, which is well below typical model
 * request latency. Returns a `dispose()` function that clears the poll timer.
 */
export function createCancelSignal(opts: {
  runId: RunId;
  upstream: AbortSignal;
  kv: KvLike;
  pollIntervalMs?: number;
}): { signal: AbortSignal; dispose: () => void; cancelled: () => boolean } {
  const controller = new AbortController();
  const interval = opts.pollIntervalMs ?? 500;
  let cancelled = false;

  const onUpstreamAbort = () => {
    cancelled = true;
    controller.abort(opts.upstream.reason ?? new Error("upstream abort"));
  };
  if (opts.upstream.aborted) {
    onUpstreamAbort();
  } else {
    opts.upstream.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  const timer = setInterval(async () => {
    if (controller.signal.aborted) return;
    try {
      const val = await opts.kv.get(cancelKey(opts.runId));
      if (val !== null) {
        cancelled = true;
        controller.abort(new Error("cancelled via KV"));
      }
    } catch {
      // Best-effort poll; KV blips don't cancel the run.
    }
  }, interval);
  // Don't keep the event loop alive just for cancel polling.
  timer.unref?.();

  return {
    signal: controller.signal,
    dispose: () => {
      clearInterval(timer);
      opts.upstream.removeEventListener("abort", onUpstreamAbort);
    },
    cancelled: () => cancelled || controller.signal.aborted,
  };
}

/** Synchronously check if a run has a cancel flag set. */
export async function isCancelled(kv: KvLike, runId: RunId): Promise<boolean> {
  const v = await kv.get(cancelKey(runId));
  return v !== null;
}

/** Set the cancel flag with a default 24h TTL. */
export async function requestCancel(
  kv: KvLike,
  runId: RunId,
  reason = "user_requested",
): Promise<void> {
  await kv.set(cancelKey(runId), reason, "EX", 24 * 60 * 60);
}

/** Clear the cancel flag (e.g. after the run terminates). */
export async function clearCancel(kv: KvLike, runId: RunId): Promise<void> {
  await kv.del(cancelKey(runId));
}
