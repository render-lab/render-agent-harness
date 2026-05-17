import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import type { DeploymentInfo } from "./api.js";
import { getDeployment } from "./api.js";

/**
 * Browser-side context carrying the running deployment's bundle metadata
 * (`/deployment` response). Populated at App boot so the header label
 * and the Guide sections can template against the actual bundle name,
 * agent list, and runtimes instead of hardcoded "operator-demo"
 * placeholders.
 *
 * Until the fetch resolves the value is `null`; consumers fall back to
 * a "operator" / "agent" placeholder so the UI never blanks out. The
 * fetch failing (e.g. older server with no /deployment route) is
 * absorbed silently for the same reason.
 */
const DeploymentContext = createContext<DeploymentInfo | null>(null);

export function DeploymentProvider({ children }: { children: ReactNode }) {
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDeployment()
      .then((d) => {
        if (!cancelled) setDeployment(d);
      })
      .catch(() => {
        // Older server / not-yet-deployed route: leave null. Consumers
        // render their fallback strings ("operator", "agent").
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <DeploymentContext.Provider value={deployment}>{children}</DeploymentContext.Provider>;
}

/** Returns the deployment info, or `null` while it's still loading. */
export function useDeployment(): DeploymentInfo | null {
  return useContext(DeploymentContext);
}

/**
 * Convenience: returns the bundle name with a fallback placeholder, so
 * callers don't have to repeat the `?? "agent"` everywhere. The fallback
 * only shows while the `/deployment` fetch is in flight (one event-loop
 * turn in practice).
 */
export function useDeploymentName(fallback = "agent"): string {
  const d = useDeployment();
  return d?.name ?? fallback;
}

export function useHarnessVersionLabel(): string {
  const d = useDeployment();
  const harness = d?.harness;
  if (!harness) return "Harness unknown";
  const versions = Object.values(harness.running);
  const unique = [...new Set(versions)];
  if (harness.status === "unknown" || unique.length === 0) return "Harness unknown";
  if (unique.length > 1) return "Harness mixed";
  return `Harness ${unique[0]}`;
}
