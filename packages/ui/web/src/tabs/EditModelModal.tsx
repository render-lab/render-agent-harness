import { useState } from "react";
import { type AgentModelSummary, type AgentSummary, updateAgentModel } from "../api.js";
import { ModelPicker } from "../components/ModelPicker.js";
import { isValidSpec, matchPreset } from "../lib/model-presets.js";

/**
 * Modal that lets an operator pick a new model for an agent and
 * commit it. On save, the worker proxies to the wizard, which writes
 * to the scaffolded repo. Render's auto-deploy then redeploys the
 * worker with the new model.
 */
export function EditModelModal({
  agent,
  onClose,
  onSaved,
}: {
  agent: AgentSummary;
  onClose: () => void;
  onSaved: (newSpec: AgentModelSummary) => void;
}) {
  const initialSpec = stripUndefined(agent.model);
  const [presetId, setPresetId] = useState(() => matchPreset(initialSpec).id);
  const [spec, setSpec] = useState<AgentModelSummary>(initialSpec);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  const valid = isValidSpec(spec);

  const onSave = async () => {
    setSubmitting(true);
    setError(null);
    setInstallUrl(null);
    try {
      const res = await updateAgentModel(agent.name, spec);
      if (res.ok) {
        onSaved(spec);
        onClose();
        return;
      }
      if (res.error === "needs_install" && res.installUrl) {
        setError("The render-harness GitHub App isn't installed on this repo yet.");
        setInstallUrl(res.installUrl);
        return;
      }
      setError(explainError(res.error, res.details));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        className="panel relative max-h-[90vh] w-full max-w-lg overflow-auto bg-bg p-5 text-xs"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit model for ${agent.name}`}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide">edit model — {agent.name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="border border-line px-2 py-1 text-xs"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <ModelPicker
          spec={spec}
          presetId={presetId}
          onChange={(next) => {
            setPresetId(next.presetId);
            setSpec(next.spec);
          }}
        />

        {error ? (
          <div className="mt-4 border border-line p-2 text-[11px]">
            <p>{error}</p>
            {installUrl ? (
              <p className="mt-2">
                <a
                  className="text-accent underline"
                  href={installUrl}
                  target="_top"
                  rel="noreferrer"
                >
                  Install the render-harness GitHub App →
                </a>
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="mt-3 text-[11px] text-muted">
          Saving commits to <span className="font-mono">render-harness.yaml</span> on the agent's
          repo. Render auto-deploys on push; the new model takes effect once the rolling restart
          completes.
        </p>

        <footer className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="border border-line px-3 py-1.5 text-xs"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={submitting || !valid}
            className="border border-accent bg-accent px-3 py-1.5 text-xs text-bg disabled:opacity-50"
          >
            {submitting ? "saving…" : "save & redeploy"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function explainError(code: string | undefined, details: string | undefined): string {
  switch (code) {
    case "wizard_service_not_configured":
      return "In-UI edits aren't wired up on this deployment. Set RENDER_HARNESS_WIZARD_URL on the worker service to enable them.";
    case "wizard_shared_secret_not_configured":
      return "Set WIZARD_SHARED_SECRET on both the worker and wizard services. They must match.";
    case "repo_locator_missing":
      return "`.render-harness/agent.json` is missing or has null org/repo. The wizard's scaffolder writes this; CLI-scaffolded repos need the install flow to populate it.";
    case "agent_not_found":
      return "Agent id wasn't found in the deployed render-harness.yaml. Has it been renamed since this deploy?";
    case "stale_sha":
      return "Someone else committed to render-harness.yaml under us. Reload and retry.";
    case "invalid_model_spec":
      return `The spec didn't validate: ${details ?? "unknown reason"}`;
    default:
      return details ?? code ?? "save failed";
  }
}

function stripUndefined(spec: AgentModelSummary): AgentModelSummary {
  const out: AgentModelSummary = { provider: spec.provider, model: spec.model };
  if (spec.baseURL) out.baseURL = spec.baseURL;
  if (spec.apiKeyEnv) out.apiKeyEnv = spec.apiKeyEnv;
  if (spec.thinking) out.thinking = { ...spec.thinking };
  return out;
}
