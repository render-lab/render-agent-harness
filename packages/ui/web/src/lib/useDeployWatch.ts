import { useEffect, useRef, useState } from "react";
import { getHealth } from "../api.js";

/**
 * Watch for a service restart by polling `/healthz`.
 *
 * State machine:
 *
 *   idle        →  no polling, waiting to be enabled
 *   restarting  →  /healthz is unreachable or non-200 (Render is in the
 *                  middle of swapping the running process)
 *   restored    →  /healthz returned 200 *after* we were `restarting`
 *
 * The hook intentionally requires a "down" observation before reporting
 * `restored`. That matters because Render's deploy queue may take a
 * couple seconds to actually kill the running process — if we just
 * watched for 200 we'd flap to `restored` immediately on the first poll
 * (the old process is still up). The down→up transition is the actual
 * "new bundle is live" signal.
 *
 * Pass `enabled: true` to start watching. The caller can leave it true
 * indefinitely; once `restored` lands the hook stops polling on its own.
 *
 * If `restartGraceMs` elapses while we're still `idle` (i.e. /healthz
 * never went down), the watcher gives up and flips straight to
 * `restored` so the UI doesn't get stuck telling the user to wait. This
 * covers the case where the env-var write didn't actually queue a
 * deploy (rare; the backend should report `save_only` in that case,
 * but belt-and-braces).
 */
export type DeployWatchState = "idle" | "restarting" | "restored";

interface UseDeployWatchOpts {
  enabled: boolean;
  /** Poll interval in ms. Default 1500. */
  pollIntervalMs?: number;
  /**
   * If we never observe a `down` within this many ms of being enabled,
   * give up and flip to `restored`. Default 20000.
   */
  restartGraceMs?: number;
}

export function useDeployWatch({
  enabled,
  pollIntervalMs = 1500,
  restartGraceMs = 20_000,
}: UseDeployWatchOpts): DeployWatchState {
  const [state, setState] = useState<DeployWatchState>("idle");
  const stateRef = useRef<DeployWatchState>("idle");
  stateRef.current = state;

  useEffect(() => {
    if (!enabled) {
      setState("idle");
      return;
    }

    let cancelled = false;
    const enabledAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      let healthy = false;
      try {
        const res = await getHealth();
        healthy = Boolean(res?.ok);
      } catch {
        healthy = false;
      }
      if (cancelled) return;

      const elapsed = Date.now() - enabledAt;
      const prev = stateRef.current;

      if (!healthy) {
        if (prev !== "restarting") setState("restarting");
      } else if (prev === "restarting") {
        setState("restored");
        return;
      } else if (prev === "idle" && elapsed >= restartGraceMs) {
        // /healthz never went down. Give up and treat as restored so
        // the UI moves forward.
        setState("restored");
        return;
      }

      timer = window.setTimeout(tick, pollIntervalMs);
    };

    let timer = window.setTimeout(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, pollIntervalMs, restartGraceMs]);

  return state;
}
