import type { WizardState } from "../lib/types.js";
import { StepShell } from "./StepShell.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function Basics({
  state,
  onChange,
  onNext,
}: {
  state: WizardState;
  onChange: (next: WizardState) => void;
  onNext: () => void;
}) {
  const nameValid = SLUG_RE.test(state.agentName);
  const descValid = state.description.length > 0 && state.description.length <= 280;
  return (
    <StepShell
      title="Name and description"
      description="The slug lands in render-harness.yaml and package.json. Lowercase + hyphens only."
      onNext={onNext}
      nextDisabled={!nameValid || !descValid}
    >
      <Field label="agent name" hint="lowercase, hyphens">
        <input
          type="text"
          value={state.agentName}
          onChange={(e) => onChange({ ...state, agentName: e.target.value })}
          className="w-full"
          style={!nameValid ? { borderColor: "var(--color-err)" } : undefined}
        />
      </Field>
      <Field label="description" hint="≤280 chars">
        <input
          type="text"
          value={state.description}
          onChange={(e) => onChange({ ...state, description: e.target.value })}
          className="w-full"
          style={!descValid ? { borderColor: "var(--color-err)" } : undefined}
        />
      </Field>
    </StepShell>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: input is rendered as a child via the children prop
    <label className="block">
      <span className="label">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-muted">{hint}</span>}
      <span className="mt-2 block">{children}</span>
    </label>
  );
}
