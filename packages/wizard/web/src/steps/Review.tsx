import type { WizardState } from "../lib/types.js";
import { StepShell } from "./StepShell.js";

export function Review({
  state,
  onSubmit,
  onPrev,
}: {
  state: WizardState;
  onSubmit: () => void;
  onPrev: () => void;
}) {
  return (
    <StepShell
      title="Review"
      description="One last look. Create will provision a private repository in the Render-managed GitHub org and commit the scaffolded files."
      onNext={onSubmit}
      onPrev={onPrev}
      nextLabel="Create agent →"
    >
      <dl className="space-y-2.5 text-sm">
        <Row label="name">{state.agentName}</Row>
        <Row label="description">{state.description}</Row>
        <Row label="model">
          <span className="font-mono text-[12px]">
            {state.model.provider}/{state.model.model}
          </span>
          {state.model.baseURL ? (
            <div className="text-[11px] text-muted">via {state.model.baseURL}</div>
          ) : null}
          {state.model.apiKeyEnv ? (
            <div className="text-[11px] text-muted">key: {state.model.apiKeyEnv}</div>
          ) : null}
        </Row>
        <Row label="runtimes">
          {state.runtimes.map((r) => r.kind).join(" + ")}
          {state.ui && <span className="ml-2 text-[11px] text-muted">(operator UI mounted)</span>}
        </Row>
        <Row label="capabilities">
          {state.capabilities.length === 0 ? (
            <span className="text-muted">{"// none"}</span>
          ) : (
            <ul className="space-y-0.5 text-[12px]">
              {state.capabilities.map((c) => (
                <li key={c.pack}>{c.pack}</li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="system prompt">
          <details>
            <summary className="text-muted text-[11px]">click to expand</summary>
            <pre className="mt-2 max-h-48 overflow-auto border border-line p-2 text-[12px]">
              {state.systemPrompt}
            </pre>
          </details>
        </Row>
      </dl>
      <div className="border border-accent p-3 text-[12px] text-accent">
        {
          "// ANONYMOUS — no login. Clicking Create returns a one-time link to the managed repo and a Deploy-to-Render button. The wizard won't show this agent again."
        }
      </div>
    </StepShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-baseline gap-3">
      <dt className="label">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
