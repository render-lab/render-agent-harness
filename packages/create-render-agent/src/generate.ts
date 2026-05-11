import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { agentIndex } from "./templates/agent-index.js";
import { dockerCompose } from "./templates/docker-compose.js";
import { envExample } from "./templates/env-example.js";
import { gitignore } from "./templates/gitignore.js";
import { packageJson } from "./templates/package-json.js";
import { readme } from "./templates/readme.js";
import { buildHarnessConfig, renderHarnessYaml } from "./templates/render-harness-yaml.js";
import { runtimeEntry } from "./templates/runtime-entries.js";
import { tsconfig } from "./templates/tsconfig.js";
import { tsupConfig } from "./templates/tsup-config.js";
import { type Answers, entryFileFor, isMultiRuntime } from "./types.js";
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
 */
export function buildFileMap(answers: Answers): Map<string, string> {
  const multi = isMultiRuntime(answers);
  const files = new Map<string, string>();

  // Validate before emitting any file content. Throws ZodError on failure.
  validateHarnessConfig(buildHarnessConfig(answers));

  files.set("render-harness.yaml", renderHarnessYaml(answers));
  files.set("package.json", packageJson(answers));
  files.set("tsup.config.ts", tsupConfig(answers));
  files.set("tsconfig.json", tsconfig());
  files.set("README.md", readme(answers));
  files.set(".env.example", envExample(answers));
  files.set(".gitignore", gitignore());
  files.set("docker-compose.yml", dockerCompose(answers));
  files.set("agent/index.ts", agentIndex());

  for (const runtime of answers.runtimes) {
    files.set(entryFileFor(runtime.kind, multi), runtimeEntry(runtime, answers));
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
