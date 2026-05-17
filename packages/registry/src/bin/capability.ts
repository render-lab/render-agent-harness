#!/usr/bin/env node
/**
 * `render-harness-capability` — utilities for community capability pack authors.
 */

import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateCapabilityCatalog, validateCapabilityPackageDir } from "../capability-validate.js";

interface CliArgs {
  command: "validate" | "catalog-validate" | "help";
  targetPath: string;
  workspaceRoot: string | undefined;
  json: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      "workspace-root": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help)
    return { command: "help", targetPath: process.cwd(), workspaceRoot: undefined, json: false };
  const command = positionals[0] ?? "help";
  if (command === "catalog" && positionals[1] === "validate") {
    const rawPath = positionals[2] ?? "capability-catalog/index.yaml";
    return {
      command: "catalog-validate",
      targetPath: isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath),
      workspaceRoot: values["workspace-root"]
        ? resolve(String(values["workspace-root"]))
        : process.cwd(),
      json: Boolean(values.json),
    };
  }
  if (command !== "validate") {
    return { command: "help", targetPath: process.cwd(), workspaceRoot: undefined, json: false };
  }
  const rawDir = positionals[1] ?? ".";
  return {
    command,
    targetPath: isAbsolute(rawDir) ? rawDir : resolve(process.cwd(), rawDir),
    workspaceRoot: undefined,
    json: Boolean(values.json),
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "render-harness-capability — capability pack authoring tools",
      "",
      "USAGE",
      "  render-harness-capability validate [package-dir] [--json]",
      "  render-harness-capability catalog validate [catalog-path] [--workspace-root <path>] [--json]",
      "",
      "COMMANDS",
      "  validate     Validate package metadata and default CapabilityPack export.",
      "  catalog      Validate capability catalog metadata and connector keys.",
      "",
      "OPTIONS",
      "  --workspace-root  Harness repo root for official package cross-checks.",
      "  --json       Print machine-readable validation results.",
      "  -h, --help   Show this help.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return 0;
  }

  const result =
    args.command === "catalog-validate"
      ? await validateCapabilityCatalog({
          catalogPath: args.targetPath,
          ...(args.workspaceRoot ? { workspaceRoot: args.workspaceRoot } : {}),
        })
      : await validateCapabilityPackageDir(args.targetPath);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const issue of result.issues) {
      const prefix = issue.severity === "error" ? "error" : "warning";
      process.stdout.write(`${prefix}: ${issue.path}: ${issue.message}\n`);
    }
    process.stdout.write(
      result.ok ? "capability validation passed.\n" : "capability validation failed.\n",
    );
  }
  return result.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
