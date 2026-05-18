import { createRequire } from "node:module";
import type { HarnessVersionInfo } from "@render-harness/contracts";
import { satisfies, valid, validRange } from "semver";

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
  const parsedRange = declaredRange ? validRange(declaredRange) : null;
  if (!declaredRange) messages.push("render-harness.yaml does not declare harnessVersion.");
  else if (!parsedRange)
    messages.push(`render-harness.yaml declares invalid harnessVersion "${declaredRange}".`);
  if (Object.keys(running).length === 0) {
    messages.push("No running @render-harness package versions could be detected.");
    return { declaredRange, running, status: "unknown", messages };
  }

  const firstPartyVersions = Object.entries(running).filter(([name]) =>
    name.startsWith(FIRST_PARTY_PREFIX),
  );
  const uniqueVersions = [...new Set(firstPartyVersions.map(([, version]) => version))];

  if (declaredRange && !parsedRange) {
    return { declaredRange, running, status: "warning", messages };
  }

  const invalid = uniqueVersions.filter((v) => !valid(v));
  if (invalid.length > 0) {
    messages.push(`Running harness version "${invalid[0]}" is not valid semver.`);
    return { declaredRange, running, status: "warning", messages };
  }

  // Check each installed first-party version against the declared
  // range. Patch-level drift inside the range is fine — different
  // packages publish on different tracks (caps live on their own
  // versions, dependents like @render-harness/web get cascade-bumped
  // when an internal dep changes). The check only fires when at least
  // one running version actually falls outside the declared range.
  if (parsedRange) {
    const outOfRange = firstPartyVersions.filter(([, v]) => !satisfies(v, parsedRange));
    if (outOfRange.length > 0) {
      const offenders = outOfRange.map(([name, v]) => `${name}@${v}`).join(", ");
      messages.push(`Running ${offenders} does not satisfy declared range ${declaredRange}.`);
      return { declaredRange, running, status: "incompatible", messages };
    }
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
