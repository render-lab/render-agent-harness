import { KNOWN_MODELS } from "../lib/state.js";
import type { WizardState } from "../lib/types.js";
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
  return (
    <StepShell
      title="Model"
      description="The Claude model the agent uses."
      onNext={onNext}
      onPrev={onPrev}
    >
      <div className="space-y-1.5">
        {KNOWN_MODELS.map((m) => {
          const selected = state.model === m.value;
          return (
            <label
              key={m.value}
              className={`flex cursor-pointer items-center justify-between border p-3 text-sm ${
                selected ? "border-accent text-accent" : "border-line"
              }`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="model"
                  value={m.value}
                  checked={selected}
                  onChange={() => onChange({ ...state, model: m.value })}
                  className="accent-[var(--color-accent)]"
                />
                <span>{m.label}</span>
              </span>
              <span className="text-[11px] text-muted">{m.hint}</span>
            </label>
          );
        })}
      </div>
    </StepShell>
  );
}
