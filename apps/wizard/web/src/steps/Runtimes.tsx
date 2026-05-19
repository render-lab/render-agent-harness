import { toggleRuntime } from "../lib/state.js";
import type { RuntimeKind, RuntimeSelection, WizardState } from "../lib/types.js";
import { StepShell } from "./StepShell.js";

const RUNTIME_INFO: Array<{ kind: RuntimeKind; label: string; hint: string }> = [
  { kind: "web", label: "web", hint: "HTTP endpoint for chat / requests" },
  { kind: "cron", label: "cron", hint: "scheduled, one-shot (needs Postgres)" },
  { kind: "worker", label: "worker", hint: "queue-backed async jobs" },
];

export function Runtimes({
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
  const update = (kind: RuntimeKind) =>
    onChange({ ...state, runtimes: toggleRuntime(state.runtimes, kind, state.agentName) });
  const updateRuntime = (kind: RuntimeKind, fn: (r: RuntimeSelection) => RuntimeSelection) =>
    onChange({
      ...state,
      runtimes: state.runtimes.map((r) => (r.kind === kind ? fn(r) : r)),
    });

  const hasCron = state.runtimes.find((r) => r.kind === "cron");
  const hasWorker = state.runtimes.find((r) => r.kind === "worker");

  return (
    <StepShell
      title="Trigger surfaces"
      description="Pick one or more. Multi-runtime agents share state (Postgres + Key Value) across surfaces."
      onNext={onNext}
      onPrev={onPrev}
      nextDisabled={state.runtimes.length === 0}
    >
      <div className="space-y-1.5">
        {RUNTIME_INFO.map((info) => {
          const selected = state.runtimes.some((r) => r.kind === info.kind);
          return (
            <label
              key={info.kind}
              className={`flex cursor-pointer items-center justify-between border p-3 text-sm ${
                selected ? "border-accent text-accent" : "border-line"
              }`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => update(info.kind)}
                  className="accent-[var(--color-accent)]"
                />
                <span>{info.label}</span>
              </span>
              <span className="text-[11px] text-muted">{info.hint}</span>
            </label>
          );
        })}
      </div>

      {hasCron && hasCron.kind === "cron" && (
        <label className="block border border-accent p-3">
          <span className="label text-accent">cron schedule (UTC, 5-field)</span>
          <input
            type="text"
            value={hasCron.schedule}
            onChange={(e) =>
              updateRuntime("cron", (r) => ({
                ...(r as { kind: "cron"; schedule: string }),
                schedule: e.target.value,
              }))
            }
            className="mt-2 w-full"
          />
        </label>
      )}

      {hasWorker && hasWorker.kind === "worker" && (
        <label className="block border border-accent p-3">
          <span className="label text-accent">worker queue name</span>
          <input
            type="text"
            value={hasWorker.queue}
            onChange={(e) =>
              updateRuntime("worker", (r) => ({
                ...(r as { kind: "worker"; queue: string }),
                queue: e.target.value,
              }))
            }
            className="mt-2 w-full"
          />
        </label>
      )}
    </StepShell>
  );
}
