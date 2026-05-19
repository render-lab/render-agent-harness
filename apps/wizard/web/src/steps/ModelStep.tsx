import { BASE_URL_ALLOWLIST, findPreset, MODEL_PRESETS } from "../lib/state.js";
import type { ModelSpec, WizardState } from "../lib/types.js";
import { StepShell } from "./StepShell.js";

export function ModelStep({
  state,
  onChange,
  onNext,
  onPrev,
}: {
  state: WizardState;
  onChange: (next: WizardState) => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  const isCustom = state.modelPresetId === "custom";
  const customValid = !isCustom || isCustomSpecValid(state.model);
  return (
    <StepShell
      title="Model"
      description="The model the agent uses. Pick a preset or roll your own."
      onNext={onNext}
      onPrev={onPrev}
      nextDisabled={!customValid}
    >
      <div className="space-y-1.5">
        {MODEL_PRESETS.map((p) => {
          const selected = state.modelPresetId === p.id;
          return (
            <label
              key={p.id}
              className={`flex cursor-pointer items-center justify-between border p-3 text-sm ${
                selected ? "border-accent text-accent" : "border-line"
              }`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="model"
                  value={p.id}
                  checked={selected}
                  onChange={() => {
                    const preset = findPreset(p.id);
                    onChange({
                      ...state,
                      modelPresetId: preset.id,
                      // When the user re-picks a non-custom preset we
                      // overwrite their spec entirely; switching to
                      // "custom" keeps whatever they had so they don't
                      // start from a blank form.
                      model: preset.spec ?? state.model,
                    });
                  }}
                  className="accent-[var(--color-accent)]"
                />
                <span>{p.label}</span>
              </span>
              <span className="text-[11px] text-muted">{p.hint}</span>
            </label>
          );
        })}
      </div>

      {isCustom ? <CustomModelForm state={state} onChange={onChange} /> : null}
    </StepShell>
  );
}

function CustomModelForm({
  state,
  onChange,
}: {
  state: WizardState;
  onChange: (next: WizardState) => void;
}) {
  const spec = state.model;
  const update = (patch: Partial<ModelSpec>) => {
    onChange({ ...state, model: normalizeSpec({ ...spec, ...patch }) });
  };
  const baseUrlHost = spec.baseURL ? safeHost(spec.baseURL) : null;
  const unfamiliarHost = baseUrlHost && !BASE_URL_ALLOWLIST.includes(baseUrlHost);

  return (
    <div className="mt-4 space-y-3 border border-line p-3 text-sm">
      <label className="block">
        <span className="block text-[11px] uppercase tracking-wide text-muted">Provider</span>
        <select
          className="mt-1 w-full border border-line bg-transparent p-2 text-sm"
          value={spec.provider}
          onChange={(e) => update({ provider: e.target.value as ModelSpec["provider"] })}
        >
          <option value="anthropic">anthropic</option>
          <option value="openai-compat">openai-compat</option>
        </select>
      </label>

      <label className="block">
        <span className="block text-[11px] uppercase tracking-wide text-muted">Model id</span>
        <input
          type="text"
          className="mt-1 w-full border border-line bg-transparent p-2 font-mono text-sm"
          value={spec.model}
          placeholder={spec.provider === "anthropic" ? "claude-sonnet-4-6" : "openai/gpt-4o"}
          onChange={(e) => update({ model: e.target.value })}
        />
      </label>

      {spec.provider === "openai-compat" ? (
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wide text-muted">
            Base URL (blank for OpenAI's default)
          </span>
          <input
            type="url"
            className="mt-1 w-full border border-line bg-transparent p-2 font-mono text-sm"
            value={spec.baseURL ?? ""}
            placeholder="https://openrouter.ai/api/v1"
            onChange={(e) => update({ baseURL: e.target.value })}
          />
          {unfamiliarHost ? (
            <p className="mt-1 text-[11px] text-muted">
              Host <span className="font-mono">{baseUrlHost}</span> isn't on the known-providers
              list. Make sure you trust it — your prompts and tool outputs will be sent there.
            </p>
          ) : null}
        </label>
      ) : null}

      <label className="block">
        <span className="block text-[11px] uppercase tracking-wide text-muted">
          API key env var
        </span>
        <input
          type="text"
          className="mt-1 w-full border border-line bg-transparent p-2 font-mono text-sm"
          value={spec.apiKeyEnv ?? ""}
          placeholder={spec.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}
          onChange={(e) => update({ apiKeyEnv: e.target.value })}
        />
        <p className="mt-1 text-[11px] text-muted">
          Must be UPPER_SNAKE_CASE. Set the secret in the Render dashboard before deploying.
        </p>
      </label>
    </div>
  );
}

function normalizeSpec(spec: ModelSpec): ModelSpec {
  const out: ModelSpec = { provider: spec.provider, model: spec.model };
  if (spec.baseURL && spec.baseURL.trim().length > 0) out.baseURL = spec.baseURL.trim();
  if (spec.apiKeyEnv && spec.apiKeyEnv.trim().length > 0) out.apiKeyEnv = spec.apiKeyEnv.trim();
  return out;
}

function isCustomSpecValid(spec: ModelSpec): boolean {
  if (!spec.model || spec.model.trim().length === 0) return false;
  if (!spec.apiKeyEnv || !/^[A-Z][A-Z0-9_]*$/.test(spec.apiKeyEnv)) return false;
  if (spec.baseURL) {
    try {
      new URL(spec.baseURL);
    } catch {
      return false;
    }
  }
  return true;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
