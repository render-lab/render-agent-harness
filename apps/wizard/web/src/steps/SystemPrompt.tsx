import type { WizardState } from "../lib/types.js";
import { StepShell } from "./StepShell.js";

export function SystemPrompt({
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
  const valid = state.systemPrompt.trim().length > 0;
  return (
    <StepShell
      title="System prompt"
      description="The agent's persona and instructions. Editable later by changing render-harness.yaml in the generated repo."
      onNext={onNext}
      onPrev={onPrev}
      nextDisabled={!valid}
    >
      <textarea
        value={state.systemPrompt}
        onChange={(e) => onChange({ ...state, systemPrompt: e.target.value })}
        rows={10}
        className="w-full"
        style={!valid ? { borderColor: "var(--color-err)" } : undefined}
      />
      <div className="label">{state.systemPrompt.length.toLocaleString()} chars</div>
    </StepShell>
  );
}
