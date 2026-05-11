#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";
import { log, outro } from "@clack/prompts";
import { resolveGallery } from "./gallery.js";
import { type GenerateResult, generate } from "./generate.js";
import { runWizard } from "./prompts.js";
import { type Answers, type PackageManager, scriptRunner } from "./types.js";

const USAGE = `Usage: create-render-agent [directory] [--gallery <path>]

Scaffolds a new Render agent harness project. If [directory] is given, it
is used as the target; otherwise the wizard prompts for it.

Options:
  -h, --help              Show this help and exit.
  -v, --version           Show the package version and exit.
  --gallery <path>        Use a live harness checkout as the gallery
                          source (path to the repo root). When omitted,
                          the CLI uses its bundled snapshot.
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
  const galleryFlagIdx = args.indexOf("--gallery");
  const galleryFlagValue = galleryFlagIdx >= 0 ? args[galleryFlagIdx + 1] : undefined;
  const packageManager = detectPackageManager();

  const gallery = await resolveGallery(
    galleryFlagValue ? { liveSourceRoot: galleryFlagValue } : {},
  ).catch((err) => {
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
