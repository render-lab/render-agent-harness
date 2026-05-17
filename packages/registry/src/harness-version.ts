import { createRequire } from "node:module";
import type { HarnessVersionInfo } from "@render-harness/contracts";

const FIRST_PARTY_PREFIX = "@render-harness/";

export const CORE_HARNESS_PACKAGES = [
  "@render-harness/core",
  "@render-harness/contracts",
  "@render-harness/registry",
  "@render-harness/runtime-web",
  "@render-harness/runtime-worker",
  "@render-harness/runtime-cron",
  "@render-harness/runtime-workflows",
  "@render-harness/web",
  "@render-harness/ui",
] as const;

export function buildHarnessVersionInfo(args: {
  declaredRange?: string | null;
  packageNames?: readonly string[];
  versions?: Record<string, string | null | undefined>;
}): HarnessVersionInfo {
  const names = args.packageNames ?? CORE_HARNESS_PACKAGES;
  const running: Record<string, string> = {};
  for (const name of names) {
    const version = args.versions ? args.versions[name] : readPackageVersion(name);
    if (version) running[name] = version;
  }

  const messages: string[] = [];
  const declaredRange = args.declaredRange ?? null;
  if (!declaredRange) messages.push("render-harness.yaml does not declare harnessVersion.");
  if (Object.keys(running).length === 0) {
    messages.push("No running @render-harness package versions could be detected.");
    return { declaredRange, running, status: "unknown", messages };
  }

  const firstPartyVersions = Object.entries(running).filter(([name]) =>
    name.startsWith(FIRST_PARTY_PREFIX),
  );
  const uniqueVersions = new Set(firstPartyVersions.map(([, version]) => version));
  if (uniqueVersions.size > 1) {
    messages.push(
      `First-party harness packages are running mixed versions: ${[...uniqueVersions].join(", ")}.`,
    );
    return { declaredRange, running, status: "warning", messages };
  }

  if (messages.length > 0) return { declaredRange, running, status: "warning", messages };
  return { declaredRange, running, status: "ok", messages };
}

export function readPackageVersion(packageName: string): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req(`${packageName}/package.json`) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
