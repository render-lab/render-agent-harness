import { useState } from "react";
import { type AgentSummary, installCapability } from "../api.js";

export function InstallCapabilityModal({
  agents,
  onClose,
  onInstalled,
}: {
  agents: AgentSummary[];
  onClose: () => void;
  onInstalled: (message: string) => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.name ?? "");
  const [pack, setPack] = useState("@render-harness/cap-slack");
  const [accessMode, setAccessMode] = useState<"read" | "read_write">("read");
  const [allowedChannels, setAllowedChannels] = useState("");
  const [requireApproval, setRequireApproval] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setInstallUrl(null);
    try {
      const config: Record<string, unknown> = {};
      if (pack === "@render-harness/cap-slack") {
        const channels = allowedChannels
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (channels.length > 0) config.allowedChannels = channels;
      }
      const res = await installCapability({ agentId, pack, accessMode, config, requireApproval });
      if (res.ok) {
        onInstalled(
          `Capability install committed. Changed files: ${(res.changedFiles ?? []).join(", ") || "none"}.`,
        );
        onClose();
        return;
      }
      if (res.error === "needs_install" && res.installUrl) {
        setInstallUrl(res.installUrl);
        setError("The render-harness GitHub App is not installed for this repo yet.");
        return;
      }
      setError(res.details ?? res.error ?? "install failed");
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
        className="panel relative w-full max-w-lg bg-bg p-5 text-xs"
        role="dialog"
        aria-modal="true"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide">add capability</h2>
          <button type="button" onClick={onClose} className="border border-line px-2 py-1 text-xs">
            close
          </button>
        </header>
        <label className="label block" htmlFor="capability-pack">
          capability
        </label>
        <select
          id="capability-pack"
          className="mt-1 w-full border border-line bg-bg p-2"
          value={pack}
          onChange={(e) => setPack(e.target.value)}
        >
          <option value="@render-harness/cap-slack">Slack</option>
          <option value="@render-harness/cap-github">GitHub</option>
          <option value="@render-harness/cap-linear">Linear</option>
          <option value="@render-harness/cap-webhook-generic">Generic webhook</option>
        </select>
        <label className="label mt-3 block" htmlFor="capability-agent">
          target agent
        </label>
        <select
          id="capability-agent"
          className="mt-1 w-full border border-line bg-bg p-2"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          {agents.map((agent) => (
            <option key={agent.name} value={agent.name}>
              {agent.name}
            </option>
          ))}
        </select>
        <label className="label mt-3 block" htmlFor="capability-access-mode">
          access mode
        </label>
        <select
          id="capability-access-mode"
          className="mt-1 w-full border border-line bg-bg p-2"
          value={accessMode}
          onChange={(e) => setAccessMode(e.target.value as "read" | "read_write")}
        >
          <option value="read">read</option>
          <option value="read_write">read_write</option>
        </select>
        {pack === "@render-harness/cap-slack" ? (
          <>
            <label className="label mt-3 block" htmlFor="capability-allowed-channels">
              allowed channels (optional, comma-separated)
            </label>
            <input
              id="capability-allowed-channels"
              className="mt-1 w-full border border-line bg-bg p-2"
              value={allowedChannels}
              onChange={(e) => setAllowedChannels(e.target.value)}
              placeholder="C0123ABC,C0456DEF"
            />
          </>
        ) : null}
        <label className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={requireApproval}
            onChange={(e) => setRequireApproval(e.target.checked)}
          />
          approval required for write tools
        </label>
        {error ? (
          <p className="mt-3 border border-line p-2 text-[11px]">
            {error}
            {installUrl ? (
              <>
                <br />
                <a
                  className="text-accent underline"
                  href={installUrl}
                  target="_top"
                  rel="noreferrer"
                >
                  Install GitHub App
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        <footer className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-line px-3 py-1.5">
            cancel
          </button>
          <button
            type="button"
            disabled={submitting || !agentId}
            onClick={submit}
            className="border border-accent bg-accent px-3 py-1.5 text-bg disabled:opacity-50"
          >
            {submitting ? "installing..." : "commit install"}
          </button>
        </footer>
      </div>
    </div>
  );
}
