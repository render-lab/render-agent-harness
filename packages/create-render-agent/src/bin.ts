#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { log, outro } from "@clack/prompts";
import { resolveGallery } from "./gallery.js";
import { type GenerateResult, generate } from "./generate.js";
import { runWizard } from "./prompts.js";
import { type Answers, type PackageManager, scriptRunner } from "./types.js";

const USAGE = `create-render-agent

Scaffold a new Render Harness project from a blank agent or an official
starter template.

Usage:
  create-render-agent [directory] [options]

Arguments:
  directory                  Target directory. If omitted, the CLI prompts for it.

Options:
  -h, --help                 Show this help and exit.
  -v, --version              Show the package version and exit.
  --harness-root <path>      Path to a local harness checkout. Loads the live
                             gallery and writes link: dependencies to the
                             scaffolded package.json. Requires pnpm.
  --capability-catalog <path>
                             Optional capability catalog YAML or JSON file.

Examples:
  pnpm dlx create-render-agent my-agent
  create-render-agent my-agent --harness-root /path/to/render-harness
  create-render-agent --capability-catalog ./capability-catalog/index.yaml

Creates:
  render-harness.yaml        Agent, runtime, model, env, and capability config.
  render.yaml                Render Blueprint generated from the manifest.
  src/                       Runtime entrypoints and agent code.
  .env.example               Local env vars to copy into .env.

After scaffold:
  cd <directory>
  cp .env.example .env
  pnpm db:up
  pnpm dev

Links:
  Docs: https://render-agent-harness.onrender.com/
  Web wizard: use the public site's /new route.
  Browse templates and community harnesses: use the public site's /browse route.
`;

async function main(): Promise<void> {
  const args = argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    stdout.write(USAGE);
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    stdout.write(`${getVersion()}\n`);
    return;
  }

  const positional = args.find((a) => !a.startsWith("-"));
  const harnessRootIdx = args.indexOf("--harness-root");
  const harnessRootRaw = harnessRootIdx >= 0 ? args[harnessRootIdx + 1] : undefined;
  const harnessRoot = harnessRootRaw ? resolve(harnessRootRaw) : null;
  const capabilityCatalogIdx = args.indexOf("--capability-catalog");
  const capabilityCatalogRaw =
    capabilityCatalogIdx >= 0 ? args[capabilityCatalogIdx + 1] : undefined;
  const capabilityCatalogPath = capabilityCatalogRaw ? resolve(capabilityCatalogRaw) : undefined;
  // --harness-root uses `link:<absolute-path>` deps in package.json. Only
  // pnpm honors that protocol correctly; npm interprets it differently
  // and `npm install` fails on the workspace links. Force pnpm in this
  // mode regardless of what `npm_config_user_agent` detected.
  const packageManager: PackageManager = harnessRoot ? "pnpm" : detectPackageManager();
  if (harnessRoot && detectPackageManager() !== "pnpm") {
    log.warn(
      "Local-link mode (--harness-root) requires pnpm; the scaffolded project uses link:/path deps that npm/yarn/bun don't fully honor. Falling back to pnpm for install — make sure it's on your PATH.",
    );
  }

  const gallery = await resolveGallery({
    ...(harnessRoot ? { liveSourceRoot: harnessRoot } : {}),
    ...(capabilityCatalogPath ? { capabilityCatalogPath } : {}),
  }).catch((err) => {
    stderr.write(`failed to load gallery: ${describeError(err)}\n`);
    exit(2);
    throw err; // unreachable, but appeases TS
  });

  let answers: Answers;
  try {
    answers = await runWizard({
      ...(positional !== undefined ? { presetDirectory: positional } : {}),
      packageManager,
      gallery,
      harnessRoot,
    });
  } catch (err) {
    stderr.write(`wizard failed: ${describeError(err)}\n`);
    exit(2);
    return;
  }

  let result: GenerateResult;
  try {
    result = await generate(answers);
  } catch (err) {
    stderr.write(`generation failed: ${describeError(err)}\n`);
    exit(2);
    return;
  }

  log.success(`Scaffolded ${result.files.length} files in ${result.targetDir}`);

  if (answers.gitInit) {
    runIn(result.targetDir, "git init -q", "git init failed (continuing)");
  }
  if (answers.installDeps) {
    runIn(
      result.targetDir,
      `${answers.packageManager} install --silent`,
      `${answers.packageManager} install failed (you can run it manually)`,
    );
  }

  outro(nextStepsMessage(result.targetDir, answers));
}

function runIn(cwd: string, cmd: string, onFailWarn: string): void {
  try {
    execSync(cmd, { cwd, stdio: "ignore" });
  } catch {
    log.warn(onFailWarn);
  }
}

function nextStepsMessage(targetDir: string, answers: Answers): string {
  const pm = answers.packageManager;
  const run = scriptRunner(pm);
  const cdLine = `cd ${shortPath(targetDir)}`;
  const installLine = answers.installDeps ? "" : `${pm} install\n  `;
  return `Next:\n  ${cdLine}\n  ${installLine}cp .env.example .env  # then fill in ANTHROPIC_API_KEY\n  ${run} db:up            # Postgres + Valkey via docker compose\n  ${run} dev`;
}

/**
 * Detect the package manager that's running this CLI from the
 * `npm_config_user_agent` env var. Set by npm/pnpm/yarn/bun whenever
 * they invoke a script (or `npm init` / `npx` / `pnpm dlx`). Defaults
 * to npm when undetectable.
 */
function detectPackageManager(): PackageManager {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm/")) return "pnpm";
  if (ua.startsWith("yarn/")) return "yarn";
  if (ua.startsWith("bun/")) return "bun";
  return "npm";
}

function shortPath(abs: string): string {
  const cwd = process.cwd();
  if (abs.startsWith(`${cwd}/`)) return abs.slice(cwd.length + 1);
  return abs;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getVersion(): string {
  // The CLI is bundled with tsup; package.json is colocated with dist/.
  // We read it at runtime so a single source of truth (package.json)
  // drives both `--version` and npm.
  const candidates = [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      if (!existsSync(url)) continue;
      const text = readFileSync(url, "utf8");
      const parsed = JSON.parse(text) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // fall through
    }
  }
  return "0.0.0-unknown";
}

main().catch((err) => {
  stderr.write(`fatal: ${describeError(err)}\n`);
  exit(2);
});
