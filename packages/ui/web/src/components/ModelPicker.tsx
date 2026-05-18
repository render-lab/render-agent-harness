import type { AgentModelSummary } from "../api.js";
import {
  BASE_URL_ALLOWLIST,
  findPreset,
  MODEL_PRESETS,
  type ModelPreset,
  normalizeSpec,
} from "../lib/model-presets.js";
import { Select } from "./Select.js";

/**
 * Flat radio list of model presets plus a "custom" sub-form. Shared
 * between any UI surface that needs to capture a {@link AgentModelSummary}.
 */
export function ModelPicker({
  spec,
  presetId,
  onChange,
}: {
  spec: AgentModelSummary;
  presetId: string;
  onChange: (next: { spec: AgentModelSummary; presetId: string }) => void;
}) {
  const isCustom = presetId === "custom";
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {MODEL_PRESETS.map((p) => (
          <PresetRow
            key={p.id}
            preset={p}
            selected={presetId === p.id}
            onSelect={() => {
              const next = findPreset(p.id);
              onChange({
                presetId: next.id,
                spec: next.spec ?? spec,
              });
            }}
          />
        ))}
      </div>
      {isCustom ? (
        <CustomFields spec={spec} onChange={(s) => onChange({ presetId, spec: s })} />
      ) : null}
    </div>
  );
}

function PresetRow({
  preset,
  selected,
  onSelect,
}: {
  preset: ModelPreset;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center justify-between border p-2 text-xs ${
        selected ? "border-accent text-accent" : "border-line"
      }`}
    >
      <span className="flex items-center gap-2">
        <input
          type="radio"
          name="model-preset"
          value={preset.id}
          checked={selected}
          onChange={onSelect}
          className="accent-[var(--color-accent)]"
        />
        <span>{preset.label}</span>
      </span>
      <span className="text-[11px] text-muted">{preset.hint}</span>
    </label>
  );
}

function CustomFields({
  spec,
  onChange,
}: {
  spec: AgentModelSummary;
  onChange: (next: AgentModelSummary) => void;
}) {
  const update = (patch: Partial<AgentModelSummary>) =>
    onChange(normalizeSpec({ ...spec, ...patch }));
  const baseUrlHost = spec.baseURL ? safeHost(spec.baseURL) : null;
  const unfamiliarHost = baseUrlHost && !BASE_URL_ALLOWLIST.includes(baseUrlHost);
  return (
    <div className="space-y-2 border border-line p-3 text-xs">
      <Field label="Provider">
        <Select<AgentModelSummary["provider"]>
          value={spec.provider}
          onChange={(provider) => update({ provider })}
          ariaLabel="provider"
          options={[
            { value: "anthropic", label: "anthropic" },
            { value: "openai-compat", label: "openai-compat" },
          ]}
        />
      </Field>
      <Field label="Model id">
        <input
          type="text"
          className="w-full border border-line bg-transparent p-1.5 font-mono text-xs"
          value={spec.model}
          placeholder={spec.provider === "anthropic" ? "claude-sonnet-4-6" : "openai/gpt-4o"}
          onChange={(e) => update({ model: e.target.value })}
        />
      </Field>
      {spec.provider === "openai-compat" ? (
        <Field label="Base URL (blank for OpenAI's default)">
          <input
            type="url"
            className="w-full border border-line bg-transparent p-1.5 font-mono text-xs"
            value={spec.baseURL ?? ""}
            placeholder="https://openrouter.ai/api/v1"
            onChange={(e) => update({ baseURL: e.target.value })}
          />
          {unfamiliarHost ? (
            <p className="mt-1 text-[10px] text-muted">
              Host <span className="font-mono">{baseUrlHost}</span> isn't on the known-providers
              list. Proceed only if you trust it.
            </p>
          ) : null}
        </Field>
      ) : null}
      <Field label="API key env var">
        <input
          type="text"
          className="w-full border border-line bg-transparent p-1.5 font-mono text-xs"
          value={spec.apiKeyEnv ?? ""}
          placeholder={spec.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}
          onChange={(e) => update({ apiKeyEnv: e.target.value })}
        />
        <p className="mt-1 text-[10px] text-muted">
          Must be UPPER_SNAKE_CASE. Set the secret in the Render dashboard before saving.
        </p>
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="block text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
