import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertCapabilityPack, type CapabilityPack } from "./capability.js";
import { type CapabilityCatalog, loadCapabilityCatalog } from "./capability-index.js";

export type CapabilityValidationSeverity = "error" | "warning";

export interface CapabilityValidationIssue {
  severity: CapabilityValidationSeverity;
  path: string;
  message: string;
}

export interface CapabilityValidationResult {
  ok: boolean;
  issues: CapabilityValidationIssue[];
}

export interface CapabilityCatalogValidationOpts {
  catalogPath: string;
  workspaceRoot?: string;
}

export interface CapabilityPackageJson {
  name?: string;
  version?: string;
  type?: string;
  description?: string;
  license?: string;
  keywords?: string[];
  main?: string;
  module?: string;
  exports?:
    | string
    | {
        [key: string]: string | { import?: string; default?: string; node?: string };
      };
  renderHarness?: {
    gallery?: {
      label?: string;
      envHint?: string;
    };
  };
}

const RESERVED_CONNECTOR_KEYS = new Set([
  "agents",
  "blueprint",
  "config",
  "connectors",
  "conversations",
  "deployment",
  "diagnostics",
  "healthz",
  "runs",
  "schedules",
  "ui",
  "usage",
]);

export async function validateCapabilityPackageDir(
  packageDir: string,
): Promise<CapabilityValidationResult> {
  const issues: CapabilityValidationIssue[] = [];
  const pkgPath = resolve(packageDir, "package.json");
  let pkg: CapabilityPackageJson;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as CapabilityPackageJson;
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          severity: "error",
          path: "package.json",
          message: `failed to read package.json: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  issues.push(...validateCapabilityPackageMetadata(pkg));

  if (issues.some((issue) => issue.severity === "error")) return toResult(issues);

  try {
    const entry = resolve(packageDir, resolvePackageEntry(pkg));
    const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown } & Record<
      string,
      unknown
    >;
    const pack = assertCapabilityPack(mod.default ?? mod, pkg.name ?? packageDir);
    issues.push(...validateCapabilityPack(pack, pkg));
  } catch (err) {
    issues.push({
      severity: "error",
      path: "exports",
      message: `failed to import capability pack: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return toResult(issues);
}

export async function validateCapabilityCatalog(
  opts: CapabilityCatalogValidationOpts,
): Promise<CapabilityValidationResult> {
  let catalog: CapabilityCatalog;
  try {
    catalog = await loadCapabilityCatalog(opts.catalogPath);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          severity: "error",
          path: opts.catalogPath,
          message: `failed to load capability catalog: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const issues: CapabilityValidationIssue[] = [];
  const connectorKeys = new Map<string, string>();
  for (const [index, entry] of catalog.capabilities.entries()) {
    const entryPath = `capabilities[${index}]`;
    for (const connector of entry.connectors) {
      for (const issue of validateConnectorKey(connector.key)) {
        issues.push({ ...issue, path: `${entryPath}.${issue.path}` });
      }
      const seenBy = connectorKeys.get(connector.key);
      if (seenBy && seenBy !== entry.package) {
        error(
          issues,
          `${entryPath}.connectors.key`,
          `connector key "${connector.key}" is already declared by ${seenBy}`,
        );
      } else {
        connectorKeys.set(connector.key, entry.package);
      }
    }

    if (opts.workspaceRoot && entry.package.startsWith("@render-harness/")) {
      const packageDir = resolve(
        opts.workspaceRoot,
        "packages",
        "capabilities",
        stripPackageScope(entry.package),
      );
      const result = await validateCapabilityPackageDir(packageDir);
      for (const issue of result.issues) {
        issues.push({
          ...issue,
          path: `${entryPath}.${issue.path}`,
        });
      }
    }
  }

  return toResult(issues);
}

export function validateCapabilityPackageMetadata(
  pkg: CapabilityPackageJson,
): CapabilityValidationIssue[] {
  const issues: CapabilityValidationIssue[] = [];
  if (!pkg.name) error(issues, "name", "package name is required");
  else if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg.name)) {
    error(issues, "name", "package name must be a valid npm package name");
  }
  if (!pkg.version) error(issues, "version", "version is required");
  if (!pkg.description) warning(issues, "description", "description improves catalog display");
  if (!pkg.license) warning(issues, "license", "license should be declared");
  if (pkg.type !== "module")
    error(issues, "type", 'capability packages must be ESM (`"type": "module"`)');
  if (!pkg.keywords?.includes("render-harness-cap")) {
    error(issues, "keywords", 'capability packages must include the "render-harness-cap" keyword');
  }
  if (!pkg.exports && !pkg.module && !pkg.main) {
    error(issues, "exports", "package must expose an ESM entry via exports, module, or main");
  }
  if (!pkg.renderHarness?.gallery?.label) {
    warning(issues, "renderHarness.gallery.label", "gallery label is recommended");
  }
  return issues;
}

export function validateCapabilityPack(
  pack: CapabilityPack,
  pkg?: CapabilityPackageJson,
): CapabilityValidationIssue[] {
  const issues: CapabilityValidationIssue[] = [];
  const expectedName = pkg?.name ? stripPackageScope(pkg.name) : null;
  if (expectedName && pack.name !== expectedName) {
    error(
      issues,
      "default.name",
      `pack.name should match package short name "${expectedName}", got "${pack.name}"`,
    );
  }
  if (pack.connectors) {
    warning(
      issues,
      "connectors",
      "connector key validation requires invoking connectors(ctx); use integration validation with safe test config",
    );
  }
  return issues;
}

export function validateConnectorKey(key: string): CapabilityValidationIssue[] {
  const issues: CapabilityValidationIssue[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
    error(issues, "connectors.key", `connector key "${key}" must match [a-z0-9][a-z0-9-]*`);
  }
  if (RESERVED_CONNECTOR_KEYS.has(key)) {
    error(issues, "connectors.key", `connector key "${key}" is reserved`);
  }
  return issues;
}

function resolvePackageEntry(pkg: CapabilityPackageJson): string {
  const exportsField = pkg.exports;
  if (typeof exportsField === "string") return exportsField;
  if (exportsField && typeof exportsField === "object") {
    const dot = exportsField["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") return dot.import ?? dot.node ?? dot.default ?? "index.js";
  }
  return pkg.module ?? pkg.main ?? "index.js";
}

function stripPackageScope(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, "");
}

function toResult(issues: CapabilityValidationIssue[]): CapabilityValidationResult {
  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

function error(issues: CapabilityValidationIssue[], path: string, message: string): void {
  issues.push({ severity: "error", path, message });
}

function warning(issues: CapabilityValidationIssue[], path: string, message: string): void {
  issues.push({ severity: "warning", path, message });
}
