import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  type Option,
  outro,
  select,
  text,
} from "@clack/prompts";
import {
  BASE_URL_ALLOWLIST,
  DEFAULT_MODEL_PRESET_ID,
  findPreset,
  MODEL_PRESETS,
  matchPreset,
} from "@render-harness/registry";
import type { ResolvedAgentEntry, ResolvedGallery } from "@render-harness/registry/gallery";
import type { ModelSpecInput } from "@render-harness/registry/schema";
import type {
  Answers,
  CapabilityPick,
  PackageManager,
  RuntimeKind,
  RuntimeSelection,
} from "./types.js";

/**
 * Run the interactive wizard. `presetDirectory`, if given, comes from
 * argv and pre-fills (and validates) the target directory without
 * prompting.
 */
export async function runWizard(options: {
  presetDirectory?: string;
  packageManager: PackageManager;
  gallery: ResolvedGallery;
  harnessRoot: string | null;
}): Promise<Answers> {
  intro("create-render-agent");

  const directory = options.presetDirectory ? options.presetDirectory : await promptDirectory();
  validateDirectory(directory);

  const template = await promptTemplate(options.gallery);

  // Sealed bundle: no per-agent prompts. Just project name + lifecycle.
  if (template && template.kind === "bundle") {
    return runBundleWizard({
      template,
      directory,
      packageManager: options.packageManager,
      harnessRoot: options.harnessRoot,
    });
  }

  const templatePrimaryAgent = template?.manifest.agents[0];
  const templateAgentBlock = templatePrimaryAgent?.agent;
  const templateModel: ModelSpecInput | undefined =
    templatePrimaryAgent?.model ?? template?.manifest.shared?.model;

  const defaultName = sanitizeName(basename(resolve(directory)));
  const agentName = await promptText({
    message: "Agent name (used in render-harness.yaml & package.json)",
    initialValue: defaultName,
    validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? undefined : "must match [a-z0-9][a-z0-9-]*"),
  });

  const description = await promptText({
    message: "Description (one line)",
    initialValue: template?.description ?? "An agent built with the Render harness.",
    validate: (v) => (v.length > 0 ? undefined : "required"),
  });

  const templatePrompt =
    templateAgentBlock?.kind === "builtin" ? templateAgentBlock.systemPrompt : null;
  const systemPrompt = await promptText({
    message: "System prompt",
    initialValue:
      templatePrompt ?? "You are a helpful assistant deployed on Render via the agent harness.",
    validate: (v) => (v.length > 0 ? undefined : "required"),
  });

  const model = await promptModel(templateModel);

  note(
    "Pick one or more — multi-runtime agents (e.g. web + cron) share the same\nagent definition and the same Postgres + Key Value state.",
    "Trigger surfaces",
  );
  const runtimeKinds = await promptRuntimes(
    (template?.runtimeKinds ?? ["web"]).filter((k) => k !== "workflows") as RuntimeKind[],
  );
  if (runtimeKinds.includes("cron")) {
    note(
      "Cron services don't auto-bundle a database. The Blueprint emitter will\nwire a Render Managed Postgres into render.yaml, and you'll need\nDATABASE_URL set when running locally (pnpm db:up in the harness repo).",
      "Cron + database",
    );
  }

  let ui = false;
  if (runtimeKinds.includes("web")) {
    ui = await promptConfirm({
      message: "Mount the operator chat UI at /ui? (recommended)",
      initialValue: true,
    });
    if (ui && !runtimeKinds.includes("worker")) {
      note(
        "The operator UI enqueues runs on a pg-boss queue, so a worker runtime\nis required to drain them. Adding worker to your selection.",
        "UI ⇒ worker",
      );
      runtimeKinds.push("worker");
    }
  }

  const runtimes: RuntimeSelection[] = [];
  for (const kind of runtimeKinds) {
    runtimes.push(await promptRuntimeDetails(kind, agentName));
  }

  const capabilities = await promptCapabilities(
    options.gallery.capabilities,
    template?.capabilities ?? [],
  );

  const gitInit = await promptConfirm({
    message: "Initialize a git repo?",
    initialValue: true,
  });

  const installDeps = await promptConfirm({
    message: `Install dependencies with ${options.packageManager}?`,
    initialValue: true,
  });

  outro("Ready to scaffold.");

  return {
    directory,
    agentName,
    description,
    systemPrompt,
    model,
    runtimes,
    capabilities,
    templateManifest: template ? (template.manifest as unknown as Record<string, unknown>) : null,
    bundle: null,
    ui,
    packageManager: options.packageManager,
    harnessRoot: options.harnessRoot,
    gitInit,
    installDeps,
  };
}

/**
 * Sealed-bundle wizard flow. Collects only project-level prompts
 * (directory, git init, install) and returns Answers with the bundle
 * payload populated. The generator materializes the manifest + source
 * tree verbatim.
 */
async function runBundleWizard(options: {
  template: ResolvedAgentEntry;
  directory: string;
  packageManager: PackageManager;
  harnessRoot: string | null;
}): Promise<Answers> {
  const { template } = options;
  const agentList = template.manifest.agents
    .map((a) => `  • ${a.id}${a.description ? ` — ${a.description}` : ""}`)
    .join("\n");
  note(
    `Bundled template "${template.name}" is sealed — it ships ${template.manifest.agents.length} agents that share one harness deployment:\n${agentList}\n\nThe wizard will write all files as-is. Customize after.`,
    "Bundle",
  );

  const gitInit = await promptConfirm({
    message: "Initialize a git repo?",
    initialValue: true,
  });
  const installDeps = await promptConfirm({
    message: `Install dependencies with ${options.packageManager}?`,
    initialValue: true,
  });

  outro("Ready to scaffold bundle.");

  return {
    directory: options.directory,
    // Single-agent fields are ignored when bundle is set, but TypeScript
    // wants them. Use deterministic placeholders.
    agentName: template.manifest.name,
    description: template.description,
    systemPrompt: "",
    model:
      template.manifest.shared?.model ??
      (findPreset(DEFAULT_MODEL_PRESET_ID).spec as ModelSpecInput),
    runtimes: [],
    capabilities: template.capabilities.map((pack) => ({ pack })),
    templateManifest: template.manifest as unknown as Record<string, unknown>,
    bundle: {
      slug: template.slug,
      manifest: template.manifest as unknown as Record<string, unknown>,
      sourceFiles: template.sourceFiles,
      runtimeKinds: template.runtimeKinds,
      capabilities: template.capabilities,
    },
    ui: template.manifest.shared?.ui ?? false,
    packageManager: options.packageManager,
    harnessRoot: options.harnessRoot,
    gitInit,
    installDeps,
  };
}

// --------------------------------------------------------------------
// Prompt helpers that bail cleanly on Ctrl+C
// --------------------------------------------------------------------

async function promptText(opts: {
  message: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  const result = await text({
    message: opts.message,
    ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
    ...(opts.validate ? { validate: opts.validate } : {}),
  });
  return unwrap(result);
}

async function promptSelect<T extends string>(opts: {
  message: string;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  initialValue?: T;
}): Promise<T> {
  const options: Array<Option<T>> = opts.options.map((o) => {
    const base = { value: o.value, label: o.label } as Option<T>;
    if (o.hint) (base as { hint?: string }).hint = o.hint;
    return base;
  });
  const result = await select<T>({
    message: opts.message,
    options,
    ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
  });
  return unwrap(result);
}

async function promptConfirm(opts: { message: string; initialValue?: boolean }): Promise<boolean> {
  const result = await confirm({
    message: opts.message,
    ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
  });
  return unwrap(result);
}

async function promptDirectory(): Promise<string> {
  return promptText({
    message: "Project directory",
    initialValue: "my-agent",
    validate: (v) => (v.length > 0 ? undefined : "required"),
  });
}

async function promptRuntimes(initialKinds: readonly RuntimeKind[]): Promise<RuntimeKind[]> {
  // v1 wizard supports web/cron/worker only — workflows are excluded until
  // render.yaml Blueprints support them (locked decision #8). Filter the
  // template's defaults so the multi-select state is valid.
  const supported: RuntimeKind[] = ["web", "cron", "worker"];
  const initialValues = initialKinds.filter((k): k is RuntimeKind => supported.includes(k));
  const result = await multiselect<RuntimeKind>({
    message: "Which runtimes should expose this agent? (space to toggle, ≥1 required)",
    options: [
      { value: "web", label: "web", hint: "HTTP endpoint for synchronous chat / requests" },
      { value: "cron", label: "cron", hint: "scheduled, one-shot (needs Postgres)" },
      { value: "worker", label: "worker", hint: "queue-backed async jobs" },
    ],
    initialValues: initialValues.length > 0 ? initialValues : ["web"],
    required: true,
  });
  return unwrap(result);
}

async function promptRuntimeDetails(
  kind: RuntimeKind,
  agentName: string,
): Promise<RuntimeSelection> {
  switch (kind) {
    case "web":
      return { kind: "web" };
    case "cron": {
      const schedule = await promptText({
        message: "Cron schedule (UTC, 5-field expression)",
        initialValue: "0 13 * * *",
        validate: (v) =>
          v.trim().split(/\s+/).length === 5 ? undefined : "expected 5 space-separated fields",
      });
      return { kind: "cron", schedule };
    }
    case "worker": {
      const queue = await promptText({
        message: "Worker queue name",
        initialValue: `${agentName}-runs`,
        validate: (v) =>
          /^[a-z0-9][a-z0-9-]*$/.test(v) ? undefined : "must match [a-z0-9][a-z0-9-]*",
      });
      return { kind: "worker", queue };
    }
  }
}

async function promptCapabilities(
  available: ReadonlyArray<{ pack: string; label: string; envHint: string | null }>,
  initial: readonly string[],
): Promise<CapabilityPick[]> {
  if (available.length === 0) return [];
  const result = await multiselect<string>({
    message: "Capability packs (optional — space to toggle, enter to confirm)",
    options: available.map((c) => ({
      value: c.pack,
      label: c.label,
      hint: c.envHint ?? "no env",
    })),
    initialValues: initial.filter((p) => available.some((c) => c.pack === p)),
    required: false,
  });
  const picked = unwrap(result);
  return picked.map((pack) => ({ pack }));
}

async function promptModel(templateModel: ModelSpecInput | undefined): Promise<ModelSpecInput> {
  const initialId = templateModel ? matchPreset(templateModel).id : DEFAULT_MODEL_PRESET_ID;
  const choice = await promptSelect({
    message: "Model",
    options: MODEL_PRESETS.map((p) => ({
      value: p.id,
      label: p.label,
      ...(p.hint ? { hint: p.hint } : {}),
    })),
    initialValue: initialId,
  });
  const preset = findPreset(choice);
  if (preset.spec) return preset.spec;
  return promptCustomModel(templateModel);
}

async function promptCustomModel(
  templateModel: ModelSpecInput | undefined,
): Promise<ModelSpecInput> {
  const provider = await promptSelect<"anthropic" | "openai-compat">({
    message: "Provider",
    options: [
      { value: "anthropic", label: "anthropic", hint: "direct Anthropic SDK" },
      {
        value: "openai-compat",
        label: "openai-compat",
        hint: "OpenAI, OpenRouter, vLLM, etc.",
      },
    ],
    initialValue: templateModel?.provider ?? "openai-compat",
  });

  const model = await promptText({
    message: "Model id (e.g. openai/gpt-4o, anthropic/claude-sonnet-4-6)",
    initialValue: templateModel?.model ?? "",
    validate: (v) => (v.length > 0 ? undefined : "required"),
  });

  let baseURL: string | undefined;
  if (provider === "openai-compat") {
    const raw = await promptText({
      message: "Base URL (leave blank for OpenAI's default)",
      initialValue: templateModel?.baseURL ?? "",
      validate: (v) => {
        if (v.length === 0) return undefined;
        try {
          const u = new URL(v);
          if (u.protocol !== "https:" && u.protocol !== "http:") return "must be http(s)";
          return undefined;
        } catch {
          return "not a valid URL";
        }
      },
    });
    if (raw.length > 0) {
      baseURL = raw;
      const host = new URL(raw).host;
      if (!BASE_URL_ALLOWLIST.includes(host)) {
        note(
          `Host "${host}" isn't on the known-providers list. Make sure you trust it — your prompts and tool outputs will be sent there.`,
          "Unfamiliar base URL",
        );
      }
    }
  }

  const apiKeyEnv = await promptText({
    message: "API key env var name",
    initialValue:
      templateModel?.apiKeyEnv ??
      (provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"),
    validate: (v) => (/^[A-Z][A-Z0-9_]*$/.test(v) ? undefined : "must be UPPER_SNAKE_CASE"),
  });

  const spec: ModelSpecInput = { provider, model, apiKeyEnv };
  if (baseURL) spec.baseURL = baseURL;
  return spec;
}

async function promptTemplate(gallery: ResolvedGallery): Promise<ResolvedAgentEntry | null> {
  if (gallery.agents.length === 0) return null;
  const options: Array<{ value: string; label: string; hint?: string }> = [
    { value: "__blank__", label: "Blank — fill everything in" },
    ...gallery.agents.map((a) => ({
      value: a.slug,
      label: a.name,
      hint: a.description,
    })),
  ];
  const choice = await promptSelect({
    message: "Start from a template or blank?",
    options,
    initialValue: "__blank__",
  });
  if (choice === "__blank__") return null;
  return gallery.agents.find((a) => a.slug === choice) ?? null;
}

// --------------------------------------------------------------------
// Cancellation & validation
// --------------------------------------------------------------------

function unwrap<T>(result: T | symbol): T {
  if (isCancel(result)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return result as T;
}

function validateDirectory(dir: string): void {
  const abs = resolve(dir);
  if (existsSync(abs)) {
    note(`Target directory exists: ${abs}\nIt must be empty.`, "warning");
  }
}

function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return cleaned || "my-agent";
}
