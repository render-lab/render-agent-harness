import { ensureWorkerForUi } from "../lib/state.js";
import type { WizardState } from "../lib/types.js";
import { StepShell } from "./StepShell.js";

export function UiToggle({
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
  const hasWeb = state.runtimes.some((r) => r.kind === "web");

  if (!hasWeb) {
    return (
      <StepShell
        title="Operator UI"
        description="The operator UI mounts on top of the web runtime. Web isn't selected — this step is a no-op."
        onNext={onNext}
        onPrev={onPrev}
      >
        <p className="label">{"// skipped"}</p>
      </StepShell>
    );
  }

  return (
    <StepShell
      title="Operator UI"
      description="Mount the operator chat UI at /ui. Lets you talk to your agent from a browser without writing your own client."
      onNext={onNext}
      onPrev={onPrev}
    >
      <label
        className={`flex cursor-pointer items-start gap-3 border p-3 ${
          state.ui ? "border-accent text-accent" : "border-line"
        }`}
      >
        <input
          type="checkbox"
          checked={state.ui}
          onChange={(e) => {
            const ui = e.target.checked;
            const runtimes = ensureWorkerForUi(state.runtimes, ui, state.agentName);
            onChange({ ...state, ui, runtimes });
          }}
          className="mt-0.5 accent-[var(--color-accent)]"
        />
        <span className="text-sm">
          <span className="block">Include operator UI</span>
          <span className="mt-1 block text-[11px] text-muted">
            Adds{" "}
            <code className="bg-[var(--color-code-bg)] px-1 text-[11px]">
              @render-harness/web + ui
            </code>{" "}
            and the worker runtime (UI enqueues runs on a queue that the worker drains).
          </span>
        </span>
      </label>
    </StepShell>
  );
}
