import type {
  GalleryAgent,
  ModelSpec,
  RuntimeKind,
  RuntimeSelection,
  WizardState,
} from "./types.js";

/**
 * Model presets shown in the wizard. Mirrors the canonical list in
 * `@render-harness/registry/model-presets`; kept in sync by hand so the
 * SPA bundle doesn't have to pull in the registry's zod runtime.
 *
 * Each preset carries either a full `ModelSpec` or `null` to mark the
 * synthetic "custom" entry — selecting it routes the wizard into a
 * sub-form (`<CustomModelForm>`) for provider / baseURL / apiKeyEnv.
 */
export interface ModelPreset {
  id: string;
  label: string;
  hint?: string;
  spec: ModelSpec | null;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "default (best balance)",
    spec: { provider: "anthropic", model: "claude-sonnet-4-6" },
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    hint: "Anthropic flagship",
    spec: { provider: "anthropic", model: "claude-opus-4-7" },
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    hint: "fastest Anthropic",
    spec: { provider: "anthropic", model: "claude-haiku-4-5" },
  },
  {
    id: "gpt-5-1",
    label: "GPT-5.1",
    hint: "OpenAI flagship (needs OPENAI_API_KEY)",
    spec: { provider: "openai-compat", model: "gpt-5.1", apiKeyEnv: "OPENAI_API_KEY" },
  },
  {
    id: "gpt-5-1-mini",
    label: "GPT-5.1 Mini",
    hint: "OpenAI small/fast (needs OPENAI_API_KEY)",
    spec: { provider: "openai-compat", model: "gpt-5.1-mini", apiKeyEnv: "OPENAI_API_KEY" },
  },
  {
    id: "gemini-2-5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Google flagship (needs GEMINI_API_KEY)",
    spec: {
      provider: "openai-compat",
      model: "gemini-2.5-pro",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKeyEnv: "GEMINI_API_KEY",
    },
  },
  {
    id: "gemini-2-5-flash",
    label: "Gemini 2.5 Flash",
    hint: "Google fast (needs GEMINI_API_KEY)",
    spec: {
      provider: "openai-compat",
      model: "gemini-2.5-flash",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKeyEnv: "GEMINI_API_KEY",
    },
  },
  {
    id: "grok-4",
    label: "Grok 4",
    hint: "xAI (needs XAI_API_KEY)",
    spec: {
      provider: "openai-compat",
      model: "grok-4",
      baseURL: "https://api.x.ai/v1",
      apiKeyEnv: "XAI_API_KEY",
    },
  },
  {
    id: "custom",
    label: "Custom…",
    hint: "any OpenAI-compatible gateway",
    spec: null,
  },
];

export const DEFAULT_MODEL_PRESET_ID = "claude-sonnet-4-6";

export const BASE_URL_ALLOWLIST: readonly string[] = [
  "api.anthropic.com",
  "api.openai.com",
  "openrouter.ai",
  "api.groq.com",
  "api.fireworks.ai",
  "generativelanguage.googleapis.com",
  "api.x.ai",
  "api.deepseek.com",
  "api.mistral.ai",
];

export function findPreset(id: string): ModelPreset {
  return (
    MODEL_PRESETS.find((p) => p.id === id) ??
    MODEL_PRESETS.find((p) => p.id === "custom") ??
    (MODEL_PRESETS[0] as ModelPreset)
  );
}

export function matchPreset(spec: ModelSpec): ModelPreset {
  for (const p of MODEL_PRESETS) {
    if (!p.spec) continue;
    if (
      p.spec.provider === spec.provider &&
      p.spec.model === spec.model &&
      (p.spec.baseURL ?? null) === (spec.baseURL ?? null) &&
      (p.spec.apiKeyEnv ?? null) === (spec.apiKeyEnv ?? null)
    ) {
      return p;
    }
  }
  return findPreset("custom");
}

export const DEFAULT_STATE: WizardState = {
  templateSlug: null,
  agentName: "my-agent",
  description: "An agent built on Render Loops.",
  systemPrompt:
    "You are a helpful assistant deployed on Render via the Render Loops agent runtime.",
  modelPresetId: DEFAULT_MODEL_PRESET_ID,
  model: findPreset(DEFAULT_MODEL_PRESET_ID).spec ?? {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  },
  runtimes: [{ kind: "web" }],
  ui: true,
  capabilities: [],
};

/**
 * Seed wizard state from a gallery template. Only sets fields the
 * template provides; the user can still override every value before
 * submitting.
 */
export function seedFromTemplate(t: GalleryAgent): WizardState {
  // For single-agent templates we read the V2-normalized first agent's
  // block. Bundle templates ship sealed and are scaffolded verbatim;
  // they don't seed Answers (Phase 7 wires the bundle-aware UI).
  const primary = t.manifest.agents[0];
  const agentBlock = primary?.agent;
  const templateSpec: ModelSpec | undefined = primary?.model ?? t.manifest.shared?.model;
  const matchedPreset = templateSpec
    ? matchPreset(templateSpec)
    : findPreset(DEFAULT_MODEL_PRESET_ID);
  const systemPrompt =
    agentBlock?.kind === "builtin" ? agentBlock.systemPrompt : DEFAULT_STATE.systemPrompt;
  // Filter to v1-supported kinds (drop "workflows" since render.yaml
  // Blueprints don't support workflow services yet).
  const supportedKinds: RuntimeKind[] = (t.runtimeKinds as readonly string[]).filter(
    (k): k is RuntimeKind => k === "web" || k === "worker" || k === "cron",
  );
  const runtimes: RuntimeSelection[] = supportedKinds.map((kind) => {
    if (kind === "cron") return { kind, schedule: "0 13 * * *" };
    if (kind === "worker") return { kind, queue: `${t.slug}-runs` };
    return { kind: "web" };
  });
  return {
    templateSlug: t.slug,
    agentName: t.slug,
    description: t.description,
    systemPrompt,
    modelPresetId: matchedPreset.id,
    model: templateSpec ?? DEFAULT_STATE.model,
    runtimes: runtimes.length > 0 ? runtimes : [{ kind: "web" }],
    ui: true,
    capabilities: t.capabilities.map((pack) => ({ pack })),
  };
}

/** Toggle a runtime kind, applying sensible defaults for cron/worker fields. */
export function toggleRuntime(
  current: RuntimeSelection[],
  kind: RuntimeKind,
  agentName: string,
): RuntimeSelection[] {
  const exists = current.find((r) => r.kind === kind);
  if (exists) return current.filter((r) => r.kind !== kind);
  if (kind === "web") return [...current, { kind: "web" }];
  if (kind === "cron") return [...current, { kind: "cron", schedule: "0 13 * * *" }];
  return [...current, { kind: "worker", queue: `${agentName}-runs` }];
}

/** When the UI toggle flips on and there's no worker, add one. */
export function ensureWorkerForUi(
  runtimes: RuntimeSelection[],
  ui: boolean,
  agentName: string,
): RuntimeSelection[] {
  if (!ui) return runtimes;
  if (runtimes.some((r) => r.kind === "worker")) return runtimes;
  if (!runtimes.some((r) => r.kind === "web")) return runtimes; // UI requires web; user hasn't enabled it yet
  return [...runtimes, { kind: "worker", queue: `${agentName}-runs` }];
}
