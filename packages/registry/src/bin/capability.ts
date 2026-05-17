#!/usr/bin/env node
/**
 * `render-harness-capability` — utilities for community capability pack authors.
 */

import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateCapabilityPackageDir } from "../capability-validate.js";

interface CliArgs {
  command: "validate" | "help";
  packageDir: string;
  json: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) return { command: "help", packageDir: process.cwd(), json: false };
  const command = positionals[0] ?? "help";
  if (command !== "validate") return { command: "help", packageDir: process.cwd(), json: false };
  const rawDir = positionals[1] ?? ".";
  return {
    command,
    packageDir: isAbsolute(rawDir) ? rawDir : resolve(process.cwd(), rawDir),
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
      "",
      "COMMANDS",
      "  validate     Validate package metadata and default CapabilityPack export.",
      "",
      "OPTIONS",
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

  const result = await validateCapabilityPackageDir(args.packageDir);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const issue of result.issues) {
      const prefix = issue.severity === "error" ? "error" : "warning";
      process.stdout.write(`${prefix}: ${issue.path}: ${issue.message}\n`);
    }
    process.stdout.write(
      result.ok ? "capability package is valid.\n" : "capability package is invalid.\n",
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
