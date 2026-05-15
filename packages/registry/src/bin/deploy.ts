#!/usr/bin/env node
/**
 * `render-harness deploy` — provision every resource the bundle needs
 * (Postgres, Key Value, web, worker, crons, workflow service) via the
 * Render REST API. Idempotent across re-runs via `.render-deploy.lock.json`.
 *
 * Usage:
 *   render-harness deploy [flags]
 *
 *   --api-key <key>      RENDER_API_KEY (default: env)
 *   --owner-id <id>      Render workspace id (default: RENDER_OWNER_ID env, or
 *                        auto-discovered if the API key only has one workspace)
 *   --repo <url>         Git remote URL (default: `git remote get-url origin`)
 *   --branch <name>      Branch to track (default: current HEAD)
 *   --package-name <pkg> Workspace package name for build commands
 *                        (default: @render-harness/example-<bundle-name>)
 *   --region <region>    Render region (default: oregon)
 *   --dry-run            Print the plan without calling the API
 *   -h, --help
 *
 * Exit codes:
 *   0  success
 *   1  manifest invalid / required input missing
 *   2  Render API error
 *   3  unexpected I/O
 */

import { parseArgs } from "node:util";
import { deploy } from "../deploy/index.js";
import { RenderApiError } from "../deploy/api.js";

interface CliArgs {
  apiKey: string | undefined;
  ownerId: string | undefined;
  repo: string | undefined;
  branch: string | undefined;
  packageName: string | undefined;
  region: string | undefined;
  dryRun: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "api-key": { type: "string" },
      "owner-id": { type: "string" },
      repo: { type: "string" },
      branch: { type: "string" },
      "package-name": { type: "string" },
      region: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  return {
    apiKey: values["api-key"],
    ownerId: values["owner-id"],
    repo: values.repo,
    branch: values.branch,
    packageName: values["package-name"],
    region: values.region,
    dryRun: Boolean(values["dry-run"]),
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "render-harness deploy — provision every resource via the Render API",
      "",
      "Usage: render-harness deploy [flags]",
      "",
      "Flags:",
      "  --api-key <key>      RENDER_API_KEY (default: env)",
      "  --owner-id <id>      Render workspace id (default: RENDER_OWNER_ID env)",
      "  --repo <url>         Git remote URL (default: `git remote get-url origin`)",
      "  --branch <name>      Branch to track (default: current HEAD)",
      "  --package-name <pkg> Workspace package name for build commands",
      "  --region <region>    Render region (default: oregon)",
      "  --dry-run            Print the plan without calling the API",
      "  -h, --help",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseCliArgs(argv);
  try {
    await deploy({
      ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
      ...(args.ownerId !== undefined ? { ownerId: args.ownerId } : {}),
      ...(args.repo !== undefined ? { repo: args.repo } : {}),
      ...(args.branch !== undefined ? { branch: args.branch } : {}),
      ...(args.packageName !== undefined ? { packageName: args.packageName } : {}),
      ...(args.region !== undefined ? { region: args.region } : {}),
      dryRun: args.dryRun,
    });
  } catch (err) {
    if (err instanceof RenderApiError) {
      process.stderr.write(`\nRender API error: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`\ndeploy failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(3);
});
