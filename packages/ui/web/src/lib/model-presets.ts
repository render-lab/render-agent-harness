import type { AgentModelSummary } from "../api.js";

/**
 * Model presets surfaced in the operator UI's edit-model modal.
 * Mirrors the canonical list in `@render-harness/registry/model-presets`
 * but kept local so the SPA bundle stays lean.
 */
export interface ModelPreset {
  id: string;
  label: string;
  hint?: string;
  spec: AgentModelSummary | null;
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
    spec: { provider: "openai-compat", model: "gpt-5.1", apiKeyEnv: "OPENAI_API_KEY" },
  },
  {
    id: "gpt-5-1-mini",
    label: "GPT-5.1 Mini",
    hint: "OpenAI small/fast — needs OPENAI_API_KEY",
    spec: { provider: "openai-compat", model: "gpt-5.1-mini", apiKeyEnv: "OPENAI_API_KEY" },
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
  { id: "custom", label: "Custom…", hint: "any OpenAI-compatible gateway", spec: null },
];

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

export function matchPreset(spec: AgentModelSummary): ModelPreset {
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

export function normalizeSpec(spec: AgentModelSummary): AgentModelSummary {
  const out: AgentModelSummary = { provider: spec.provider, model: spec.model };
  if (spec.baseURL && spec.baseURL.trim().length > 0) out.baseURL = spec.baseURL.trim();
  if (spec.apiKeyEnv && spec.apiKeyEnv.trim().length > 0) out.apiKeyEnv = spec.apiKeyEnv.trim();
  if (spec.thinking) out.thinking = { ...spec.thinking };
  return out;
}

export function isValidSpec(spec: AgentModelSummary): boolean {
  if (!spec.model || spec.model.trim().length === 0) return false;
  if (spec.apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(spec.apiKeyEnv)) return false;
  if (spec.baseURL) {
    try {
      new URL(spec.baseURL);
    } catch {
      return false;
    }
  }
  return true;
}
