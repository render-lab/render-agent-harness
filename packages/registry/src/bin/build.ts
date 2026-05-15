#!/usr/bin/env node
/**
 * `render-harness-build` — generates `render.yaml` from a
 * `render-harness.yaml` config file.
 *
 * Authors run this once before committing each entry. End users never
 * run it; they click a Deploy-to-Render badge that reads the committed
 * Blueprint.
 *
 * Behavior:
 *   1. Reads `render-harness.yaml` (or path passed as the first arg).
 *   2. Validates it against the Zod schema.
 *   3. Loads any capability packs from the entry's `node_modules`.
 *   4. Calls the Blueprint emitter and writes `render.yaml` next to
 *      the source.
 *   5. Prints any Dashboard-only setup steps and a Deploy-to-Render
 *      badge snippet for the README.
 *
 * Exit codes:
 *   0  success
 *   1  config or pack validation failed
 *   2  unexpected I/O error
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { emitBlueprint } from "../emitter.js";
import { loadPacks } from "../load-pack.js";
import { parseHarnessConfigYaml } from "../schema.js";

interface CliArgs {
  configPath: string;
  outputPath: string;
  packageName: string | undefined;
  region: string | undefined;
  check: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      "package-name": { type: "string" },
      region: { type: "string" },
      check: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const configArg = positionals[0] ?? "render-harness.yaml";
  const configPath = isAbsolute(configArg) ? configArg : resolve(process.cwd(), configArg);
  const outputPath = values.output
    ? isAbsolute(values.output)
      ? values.output
      : resolve(process.cwd(), values.output)
    : resolve(dirname(configPath), "render.yaml");

  return {
    configPath,
    outputPath,
    packageName: values["package-name"],
    region: values.region,
    check: Boolean(values.check),
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "render-harness-build — generate render.yaml from render-harness.yaml",
      "",
      "USAGE",
      "  npx render-harness-build [config-path] [options]",
      "",
      "ARGUMENTS",
      "  config-path           Path to render-harness.yaml. Default: ./render-harness.yaml",
      "",
      "OPTIONS",
      "  -o, --output <path>   Where to write render.yaml. Default: <config-dir>/render.yaml",
      "      --package-name    npm package name to reference in build commands.",
      "                        Default: @render-harness/example-<name>",
      "      --region <region> Default Render region. Default: oregon",
      "      --check           Don't write; exit non-zero if the existing",
      "                        render.yaml differs from what would be generated.",
      "  -h, --help            Show this help.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  let yamlText: string;
  try {
    yamlText = await readFile(args.configPath, "utf8");
  } catch (err) {
    process.stderr.write(`error: cannot read ${args.configPath}: ${(err as Error).message}\n`);
    return 2;
  }

  let config: ReturnType<typeof parseHarnessConfigYaml>;
  try {
    config = parseHarnessConfigYaml(yamlText);
  } catch (err) {
    process.stderr.write(`error: ${args.configPath}: invalid render-harness.yaml\n`);
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const entryRoot = dirname(args.configPath);
  let packs: Awaited<ReturnType<typeof loadPacks>>;
  try {
    packs = await loadPacks(
      config.capabilities ? { entryRoot, refs: config.capabilities } : { entryRoot },
    );
  } catch (err) {
    process.stderr.write(`error: capability pack load failed: ${(err as Error).message}\n`);
    return 1;
  }

  const emitOpts: Parameters<typeof emitBlueprint>[0] = { config, packs };
  if (args.packageName) emitOpts.packageName = args.packageName;
  if (args.region) emitOpts.region = args.region;

  const result = await emitBlueprint(emitOpts);

  if (args.check) {
    let existing = "";
    try {
      existing = await readFile(args.outputPath, "utf8");
    } catch {
      process.stderr.write(`error: --check: ${args.outputPath} does not exist\n`);
      return 1;
    }
    if (existing !== result.yaml) {
      process.stderr.write(
        `error: ${args.outputPath} is out of date. Re-run \`render-harness-build\` and commit.\n`,
      );
      return 1;
    }
    process.stdout.write(`${args.outputPath} is up to date.\n`);
  } else {
    await writeFile(args.outputPath, result.yaml, "utf8");
    process.stdout.write(`wrote ${args.outputPath}\n`);
  }

  printSummary(result, config);
  return 0;
}

function printSummary(
  result: Awaited<ReturnType<typeof emitBlueprint>>,
  config: ReturnType<typeof parseHarnessConfigYaml>,
): void {
  if (result.warnings.length) {
    for (const w of result.warnings) {
      process.stdout.write(`warning: ${w}\n`);
    }
  }

  if (result.dashboardSteps.length) {
    process.stdout.write("\nDashboard-only steps (Workflows services aren't Blueprintable yet):\n");
    for (const step of result.dashboardSteps) {
      process.stdout.write(`  - ${step}\n`);
    }
  }

  process.stdout.write("\nEffective env schema (for the README and the Deploy badge):\n");
  for (const spec of result.effectiveEnvSchema) {
    const tags = [spec.required ? "required" : "optional", spec.secret ? "secret" : "plain"].join(
      ", ",
    );
    const desc = spec.description ? ` — ${spec.description}` : "";
    process.stdout.write(`  ${spec.name} (${tags})${desc}\n`);
  }

  process.stdout.write("\nDeploy-to-Render badge snippet (paste into README):\n");
  process.stdout.write(
    `  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/<owner>/${config.name})\n`,
  );
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`unexpected error: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(2);
  },
);
