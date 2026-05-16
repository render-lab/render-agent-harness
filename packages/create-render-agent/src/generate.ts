import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { emitBlueprint } from "@render-harness/registry/emitter";
import { parseHarnessConfigYaml } from "@render-harness/registry/schema";
import { stringify as stringifyYaml } from "yaml";
import { agentIndex } from "./templates/agent-index.js";
import {
  bundleCronAgents,
  bundleCronEntry,
  bundleCronTriggerEntry,
  bundleDockerCompose,
  bundleEnvExample,
  bundleHasWorkflowTasks,
  bundleManifestYaml,
  bundlePackageJson,
  bundleReadme,
  bundleRuntimeKinds,
  bundleTsupConfig,
  bundleWebEntry,
  bundleWorkerEntry,
  bundleWorkflowsEntry,
} from "./templates/bundle.js";
import { dockerCompose } from "./templates/docker-compose.js";
import { envExample } from "./templates/env-example.js";
import { gitignore } from "./templates/gitignore.js";
import { packageJson } from "./templates/package-json.js";
import { readme } from "./templates/readme.js";
import { buildHarnessConfig, renderHarnessYaml } from "./templates/render-harness-yaml.js";
import { runtimeEntry } from "./templates/runtime-entries.js";
import { tsconfig } from "./templates/tsconfig.js";
import { tsupConfig } from "./templates/tsup-config.js";
import { type Answers, type BundlePick, entryFileFor, isMultiRuntime } from "./types.js";
import { validateHarnessConfig } from "./validate.js";

export type { Answers } from "./types.js";

export interface GenerateResult {
  /** Absolute path of the directory written to. */
  targetDir: string;
  /** Relative file paths emitted, in deterministic order. */
  files: string[];
}

/**
 * Build a map of `{ relativePath → fileContents }` for the scaffolded
 * project. Pure function — does not touch the filesystem. Useful for
 * snapshot testing and for the future UI scaffolder which writes via
 * GitHub API rather than disk.
 *
 * Two paths share this entrypoint:
 *   - Bundle: materialize the sealed bundle's manifest + source tree
 *     verbatim, then layer V2 runtime entrypoints on top.
 *   - Single-agent: the existing templated emit.
 */
export function buildFileMap(answers: Answers): Map<string, string> {
  if (answers.bundle) {
    return buildBundleFileMap(answers, answers.bundle);
  }

  const multi = isMultiRuntime(answers);
  const files = new Map<string, string>();

  // Validate before emitting any file content. Throws ZodError on failure.
  validateHarnessConfig(buildHarnessConfig(answers));

  files.set("render-harness.yaml", renderHarnessYaml(answers));
  files.set(".render-harness/agent.json", agentMetadataJson(answers.agentName));
  files.set("package.json", packageJson(answers));
  files.set("tsup.config.ts", tsupConfig(answers));
  files.set("tsconfig.json", tsconfig());
  files.set("README.md", readme(answers));
  // Emit both .env.example (template, checked into git) and .env
  // (gitignored, ready to edit) so the user opens .env directly and
  // fills in just the entries marked `# fill in` — no `cp` dance.
  const envContent = envExample(answers);
  files.set(".env.example", envContent);
  files.set(".env", envContent);
  files.set(".gitignore", gitignore());
  files.set("docker-compose.yml", dockerCompose(answers));
  files.set("agent/index.ts", agentIndex());

  for (const runtime of answers.runtimes) {
    files.set(entryFileFor(runtime.kind, multi), runtimeEntry(runtime, answers));
  }

  return files;
}

export function removeLocalEnvFile(files: Map<string, string>): void {
  files.delete(".env");
}

export async function addBlueprintFilesToMap(
  files: Map<string, string>,
  packageName: string,
  opts: { deploymentName?: string } = {},
): Promise<void> {
  const manifest = files.get("render-harness.yaml");
  if (!manifest) throw new Error("generated file map missing render-harness.yaml");
  const baseConfig = parseHarnessConfigYaml(manifest);
  const config = opts.deploymentName ? { ...baseConfig, name: opts.deploymentName } : baseConfig;
  if (opts.deploymentName) {
    files.set(
      "render-harness.yaml",
      stringifyYaml(config, {
        lineWidth: 100,
        minContentWidth: 40,
        aliasDuplicateObjects: false,
      }),
    );
  }
  const emitted = await emitBlueprint({ config, packageName, entrypointStyle: "repo" });
  files.set("render.yaml", emitted.yaml);
  if (emitted.dashboardSteps.length > 0) {
    files.set(
      ".render-harness/dashboard-steps.md",
      [
        "# Dashboard-only setup steps",
        "",
        "Some resources are not fully Blueprintable yet. Complete these after deploying the committed `render.yaml`.",
        "",
        ...emitted.dashboardSteps.map((step) => `- ${step}`),
        "",
      ].join("\n"),
    );
  }
}

function buildBundleFileMap(answers: Answers, bundle: BundlePick): Map<string, string> {
  const files = new Map<string, string>();
  const kinds = bundleRuntimeKinds(bundle);
  const cronAgents = bundleCronAgents(bundle);
  const hasInlineCron = cronAgents.inline.length > 0;
  const hasCronTrigger = cronAgents.trigger.length > 0;
  const hasWorkflowTasks = bundleHasWorkflowTasks(bundle);

  files.set("render-harness.yaml", bundleManifestYaml(bundle));
  files.set(".render-harness/agent.json", agentMetadataJson(answers.agentName));
  files.set("tsconfig.json", tsconfig());
  files.set(".gitignore", gitignore());
  files.set("docker-compose.yml", bundleDockerCompose(answers));
  // hasUi: when shared.ui is true the operator UI mounts at /, which
  // needs WEB_API_KEY (bearer auth) + UI_COOKIE_SECRET (session sign).
  const hasUi =
    typeof bundle.manifest === "object" &&
    bundle.manifest !== null &&
    typeof (bundle.manifest as { shared?: { ui?: unknown } }).shared === "object" &&
    (bundle.manifest as { shared?: { ui?: unknown } }).shared?.ui === true;
  const envContent = bundleEnvExample({
    manifest: bundle.manifest,
    bundleSlug: bundle.slug,
    hasWorkflowTasks,
    hasUi,
  });
  // Emit both .env.example (template, checked into git) and .env
  // (gitignored, ready to edit). Skips the `cp .env.example .env`
  // step — the user opens .env directly and fills in just the
  // entries marked `# fill in`.
  files.set(".env.example", envContent);
  files.set(".env", envContent);
  files.set(
    "package.json",
    bundlePackageJson({
      agentName: answers.agentName,
      description: answers.description,
      kinds,
      capabilities: bundle.capabilities,
      harnessRoot: answers.harnessRoot,
      hasWorkflowTasks,
      hasCronTrigger,
      hasInlineCron,
    }),
  );
  files.set("tsup.config.ts", bundleTsupConfig({ kinds, hasCronTrigger, hasWorkflowTasks }));
  files.set(
    "README.md",
    bundleReadme({
      agentName: answers.agentName,
      description: answers.description,
      bundle,
      packageManager: answers.packageManager,
      kinds,
      hasWorkflowTasks,
      hasCronTrigger,
      hasInlineCron,
    }),
  );
  if (kinds.has("web")) files.set("src/web.ts", bundleWebEntry());
  if (kinds.has("worker")) files.set("src/worker.ts", bundleWorkerEntry());
  // Inline-mode cron entry — only emit if at least one cron is via:cron.
  // A bundle whose only cron is via:workflow doesn't ship `src/cron.ts`.
  if (hasInlineCron) files.set("src/cron.ts", bundleCronEntry());
  if (hasCronTrigger) files.set("src/cron-trigger.ts", bundleCronTriggerEntry());
  if (hasWorkflowTasks) files.set("src/workflows.ts", bundleWorkflowsEntry());

  // Verbatim bundle sources last so a malformed bundle can't silently
  // overwrite a generated file (would surface as an error later, but
  // we prefer the generated ones to win on collision).
  for (const [relPath, contents] of Object.entries(bundle.sourceFiles)) {
    if (files.has(relPath)) continue;
    files.set(relPath, contents);
  }

  return files;
}

/**
 * Generate a scaffolded project at the given directory. The target
 * directory must either not exist or be empty. Writes are not atomic
 * across files, but the schema is validated *before* any file is written
 * so partial writes from a config error are not possible.
 */
export async function generate(answers: Answers): Promise<GenerateResult> {
  const targetDir = resolve(answers.directory);
  await ensureTargetDirIsEmpty(targetDir);

  const files = buildFileMap(answers);
  await addBlueprintFilesToMap(files, answers.agentName);

  await mkdir(targetDir, { recursive: true });
  for (const [relPath, contents] of files) {
    const abs = join(targetDir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }

  return {
    targetDir,
    files: [...files.keys()].sort(),
  };
}

/**
 * Metadata read by the operator UI's edit-model flow. The wizard
 * service rewrites this file when it provisions the managed repo so
 * `org`, `repo`, and `installationId` are filled in. The CLI flow
 * leaves them null — the UI surfaces a "Connect GitHub" button that
 * walks the user through installing the render-harness GitHub App on
 * their own repo, and the install callback writes back the missing
 * fields.
 */
function agentMetadataJson(agentSlug: string): string {
  const payload = {
    schemaVersion: 1,
    agentSlug,
    org: null,
    repo: null,
    installationId: null,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

async function ensureTargetDirIsEmpty(targetDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(targetDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (entries.length === 0) return;
  throw new Error(
    `target directory ${targetDir} is not empty (found: ${entries.slice(0, 5).join(", ")}${
      entries.length > 5 ? ", …" : ""
    })`,
  );
}
