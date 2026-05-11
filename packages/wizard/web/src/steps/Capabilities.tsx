import type { Gallery, WizardState } from "../lib/types.js";
import { StepShell } from "./StepShell.js";

export function Capabilities({
  state,
  gallery,
  onChange,
  onNext,
  onPrev,
}: {
  state: WizardState;
  gallery: Gallery;
  onChange: (next: WizardState) => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  const toggle = (pack: string) => {
    const has = state.capabilities.some((c) => c.pack === pack);
    onChange({
      ...state,
      capabilities: has
        ? state.capabilities.filter((c) => c.pack !== pack)
        : [...state.capabilities, { pack }],
    });
  };

  return (
    <StepShell
      title="Capabilities"
      description="Optional. Each pack contributes tools, MCP servers, or skills. Add more by editing render-harness.yaml later."
      onNext={onNext}
      onPrev={onPrev}
    >
      {gallery.capabilities.length === 0 ? (
        <p className="label">// no capability packs available</p>
      ) : (
        <div className="space-y-1.5">
          {gallery.capabilities.map((cap) => {
            const selected = state.capabilities.some((c) => c.pack === cap.pack);
            return (
              <label
                key={cap.pack}
                className={`flex cursor-pointer items-center justify-between border p-3 text-sm ${
                  selected ? "border-accent text-accent" : "border-line"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggle(cap.pack)}
                    className="accent-[var(--color-accent)]"
                  />
                  <span>{cap.label}</span>
                </span>
                <span className="text-[11px] text-muted">{cap.envHint ?? "no env"}</span>
              </label>
            );
          })}
        </div>
      )}
    </StepShell>
  );
}
