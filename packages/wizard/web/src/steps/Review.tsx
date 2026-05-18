import type { AuthMe } from "../lib/api.js";
import type { WizardState } from "../lib/types.js";
import { StepShell } from "./StepShell.js";

export function Review({
  state,
  me,
  onSubmit,
  onPrev,
}: {
  state: WizardState;
  me: AuthMe | null;
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
      {me ? (
        <div className="flex items-center gap-3 border border-accent p-3 text-[12px] text-accent">
          {me.avatarUrl ? (
            <img
              src={me.avatarUrl}
              alt=""
              width={20}
              height={20}
              className="rounded-full border border-line"
            />
          ) : null}
          <span>
            {"// SIGNED IN as @"}
            {me.login}
            {
              " — the new repo will be linked to your account. You'll be added as a collaborator and it will show up under My harnesses."
            }
          </span>
        </div>
      ) : (
        <div className="border border-accent p-3 text-[12px] text-accent">
          {
            "// ANONYMOUS — no login. The success screen will show a one-time claim link you can use later to associate this harness with a GitHub account. "
          }
          <a className="underline" href={`/api/auth/login?next=${encodeURIComponent("/new")}`}>
            Sign in with GitHub
          </a>
          {" first to link the repo to you automatically."}
        </div>
      )}
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
