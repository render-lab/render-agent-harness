/**
 * Curated model presets shown by both the CLI scaffolder
 * (`create-render-agent`) and the browser wizard. Each preset carries a
 * full {@link ModelSpecInput} so the resulting `render-harness.yaml`
 * gets a complete `provider` / `baseURL` / `apiKeyEnv` block — no
 * post-scaffold hand-editing required.
 *
 * The list is intentionally short. Power users pick "custom" and supply
 * their own `provider` + `baseURL` + `apiKeyEnv` interactively.
 */

import type { ModelSpecInput } from "./schema.js";

export interface ModelPreset {
  /** Stable identifier used by both the CLI select and the SPA radio list. */
  id: string;
  label: string;
  hint?: string;
  /**
   * Full ModelSpec to emit. `null` marks the synthetic "custom" entry —
   * the scaffolder branches into a sub-form when it sees this.
   */
  spec: ModelSpecInput | null;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "default — best balance",
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
    hint: "OpenAI flagship — needs OPENAI_API_KEY",
    spec: {
      provider: "openai-compat",
      model: "gpt-5.1",
      apiKeyEnv: "OPENAI_API_KEY",
    },
  },
  {
    id: "gpt-5-1-mini",
    label: "GPT-5.1 Mini",
    hint: "OpenAI small/fast — needs OPENAI_API_KEY",
    spec: {
      provider: "openai-compat",
      model: "gpt-5.1-mini",
      apiKeyEnv: "OPENAI_API_KEY",
    },
  },
  {
    id: "gemini-2-5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Google flagship — needs GEMINI_API_KEY",
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
    hint: "Google fast — needs GEMINI_API_KEY",
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
    hint: "xAI — needs XAI_API_KEY",
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

/** Default preset id when nothing else is specified. */
export const DEFAULT_MODEL_PRESET_ID = "claude-sonnet-4-6";

/**
 * Recognised baseURL hosts. The schema accepts any HTTPS URL — this
 * list is a UX nudge ("looks unfamiliar, are you sure?") for the
 * custom-provider sub-form; it is NOT a security boundary.
 */
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

/**
 * Look up a preset by id. Returns the "custom" preset when the id is
 * unknown so callers can render the custom form rather than crashing.
 */
export function findPreset(id: string): ModelPreset {
  return (
    MODEL_PRESETS.find((p) => p.id === id) ??
    MODEL_PRESETS.find((p) => p.id === "custom") ??
    (MODEL_PRESETS[0] as ModelPreset)
  );
}

/**
 * Pick the preset whose spec matches a given {@link ModelSpecInput}.
 * Falls back to "custom" when no preset matches exactly (e.g. the user
 * picked a custom baseURL or apiKeyEnv during a prior scaffold).
 */
export function matchPreset(spec: ModelSpecInput): ModelPreset {
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
