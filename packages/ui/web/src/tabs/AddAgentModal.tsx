import { useEffect, useMemo, useState } from "react";
import { type AddableAgent, addAgent, fetchAgentCatalog } from "../api.js";

/**
 * Operator-UI modal for adding an agent extracted from a bundle gallery
 * entry to the deployed harness. Mirrors the InstallCapabilityModal
 * flow:
 *
 *  - Fetches the catalog directly from the wizard service (the deployed
 *    harness doesn't bundle the gallery).
 *  - Lets the user pick a unit, summarizes runtime kinds + capabilities
 *    + env vars the agent will pull in.
 *  - POSTs to `/agents/add` on the local web service; that proxies to
 *    the wizard which commits to the managed repo.
 */
export function AddAgentModal({
  wizardUrl,
  onClose,
  onAdded,
}: {
  wizardUrl: string;
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const [catalog, setCatalog] = useState<AddableAgent[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAgentCatalog(wizardUrl)
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.agents);
        const first = res.agents[0];
        setSelectedKey(first ? agentKey(first) : null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalogError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wizardUrl]);

  const selected = useMemo(
    () => catalog?.find((a) => agentKey(a) === selectedKey) ?? null,
    [catalog, selectedKey],
  );

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    setInstallUrl(null);
    try {
      const res = await addAgent({ bundleSlug: selected.bundleSlug, agentId: selected.agentId });
      if (res.ok) {
        const files = (res.changedFiles ?? []).join(", ") || "none";
        onAdded(`Agent ${selected.agentId} added. Changed files: ${files}.`);
        onClose();
        return;
      }
      if (res.error === "needs_install" && res.installUrl) {
        setInstallUrl(res.installUrl);
        setError("The render-harness GitHub App is not installed for this repo yet.");
        return;
      }
      setError(res.details ?? res.error ?? "add agent failed");
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
          <h2 className="text-sm font-bold uppercase tracking-wide">add agent</h2>
          <button type="button" onClick={onClose} className="border border-line px-2 py-1 text-xs">
            close
          </button>
        </header>

        {catalogError ? (
          <p className="border border-line p-2 text-[11px]">
            Could not load agent catalog from the wizard: {catalogError}
          </p>
        ) : !catalog ? (
          <p className="text-muted">Loading catalog…</p>
        ) : catalog.length === 0 ? (
          <p className="text-muted">No addable agents in the catalog yet.</p>
        ) : (
          <>
            <label className="label block" htmlFor="add-agent-pick">
              pick an agent
            </label>
            <select
              id="add-agent-pick"
              className="mt-1 w-full border border-line bg-bg p-2"
              value={selectedKey ?? ""}
              onChange={(e) => setSelectedKey(e.target.value || null)}
            >
              {catalog.map((agent) => (
                <option key={agentKey(agent)} value={agentKey(agent)}>
                  {agent.bundleName} / {agent.agentId} ({agent.runtimeKinds.join(", ")})
                </option>
              ))}
            </select>

            {selected ? (
              <div className="mt-4 border border-line p-3 text-[11px]">
                <p className="font-mono">{selected.description || "no description"}</p>
                <Detail label="runtimes" items={selected.runtimeKinds} />
                <Detail label="capabilities" items={selected.capabilities} />
                <Detail label="env vars added" items={selected.envVars} />
                {selected.workflowTask ? (
                  <p className="mt-2 text-muted">
                    {"// workflow task — registers on the bundle's Workflow service"}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}

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
            disabled={submitting || !selected}
            onClick={submit}
            className="border border-accent bg-accent px-3 py-1.5 text-bg disabled:opacity-50"
          >
            {submitting ? "adding..." : "commit add"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Detail({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mt-2">
      <span className="label">{label}:</span>{" "}
      {items.length === 0 ? <span className="text-muted">none</span> : items.join(", ")}
    </div>
  );
}

function agentKey(agent: AddableAgent): string {
  return `${agent.bundleSlug}::${agent.agentId}`;
}
