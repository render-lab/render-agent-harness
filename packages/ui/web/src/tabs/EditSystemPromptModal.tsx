import { useState } from "react";
import { type AgentSummary, updateAgentSystemPrompt } from "../api.js";

const MAX_PROMPT_CHARS = 50_000;

/**
 * Modal that lets an operator edit the system prompt of a builtin
 * (`kind: chat`) agent. On save, the harness commits the change to
 * `render-harness.yaml` via the deploy-key path (or wizard proxy
 * fallback). Render's auto-deploy then redeploys with the new prompt.
 *
 * Custom (TS-entrypoint) agents never reach this modal — the Agents tab
 * hides the Edit button and surfaces a "defined in <entrypoint>" hint
 * instead, because their prompt lives in source code and can't be
 * safely rewritten from here.
 */
export function EditSystemPromptModal({
  agent,
  initialValue,
  onClose,
  onSaved,
}: {
  agent: AgentSummary;
  initialValue: string;
  onClose: () => void;
  onSaved: (newPrompt: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  const trimmedLength = value.trim().length;
  const charCount = value.length;
  const overLimit = charCount > MAX_PROMPT_CHARS;
  const empty = trimmedLength === 0;
  const unchanged = value === initialValue;
  const canSave = !submitting && !overLimit && !empty && !unchanged;

  const onSave = async () => {
    setSubmitting(true);
    setError(null);
    setInstallUrl(null);
    try {
      const res = await updateAgentSystemPrompt(agent.name, value);
      if (res.ok) {
        onSaved(value);
        onClose();
        return;
      }
      if (res.error === "needs_install" && res.installUrl) {
        setError("The render-harness GitHub App isn't installed on this repo yet.");
        setInstallUrl(res.installUrl);
        return;
      }
      if (res.error === "agent_not_editable") {
        setError(
          `This agent is defined in ${res.entrypoint ?? "TypeScript source"} and can't be edited from the operator UI. Update the source file in your repo and redeploy.`,
        );
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
        className="panel relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden bg-bg p-5 text-xs"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit system prompt for ${agent.name}`}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide">
            edit system prompt — {agent.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="border border-line px-2 py-1 text-xs"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <label className="label mb-1" htmlFor="system-prompt-textarea">
          system prompt
        </label>
        <textarea
          id="system-prompt-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          className="min-h-[18rem] flex-1 resize-y border border-line bg-bg p-2 font-mono text-[11px] leading-relaxed text-text"
          aria-label="system prompt"
        />
        <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
          <span>
            {charCount.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()} chars
          </span>
          {overLimit ? <span className="text-accent">over limit</span> : null}
          {empty ? <span className="text-accent">prompt cannot be empty</span> : null}
        </div>

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
          repo. Render auto-deploys on push; the new prompt takes effect once the rolling restart
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
            disabled={!canSave}
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
    case "edit_in_ui_not_configured":
      return `Edit-in-UI commits aren't configured on this harness. ${details ?? ""}`.trim();
    case "repo_locator_missing":
      return "`.render-harness/agent.json` is missing or has null org/repo. The wizard's scaffolder writes this; CLI-scaffolded repos need the install flow to populate it.";
    case "agent_not_found":
    case "agent_not_found_in_manifest":
      return "Agent id wasn't found in the deployed render-harness.yaml — has it been renamed since this deploy?";
    case "stale_sha":
      return "Someone else committed to render-harness.yaml under us. Reload and retry.";
    case "invalid_manifest":
      return `Manifest didn't parse: ${details ?? "unknown reason"}`;
    case "invalid_system_prompt":
      return `Invalid system prompt: ${details ?? "unknown reason"}`;
    default:
      return details ?? code ?? "save failed";
  }
}
