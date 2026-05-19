import { useEffect, useMemo, useState } from "react";
import { type AddableAgent, ApiError, addAgent, fetchAgentCatalog } from "../api.js";

/**
 * Operator-UI modal for adding an agent from the gallery catalog to the
 * deployed harness.
 *
 * Flow:
 *
 *   1. Catalog fetched via the local `/agents/catalog` proxy (same-origin,
 *      no CORS dance — see packages/web/src/routes/agent-add.ts).
 *   2. Operator picks an entry from a filterable card grid.
 *   3. `POST /agents/add` proxies to the wizard, which commits the
 *      agents[] entry, source file (if any), capability dedupe, and
 *      re-emitted render.yaml to the managed repo.
 *
 * Server errors hint at remaining configuration: `needs_install` surfaces
 * the GitHub App install URL; `wizard_shared_secret_not_configured` /
 * `repo_locator_missing` are explained inline with a pointer at the
 * Config tab.
 */

interface AddAgentModalProps {
  onClose: () => void;
  onAdded: (message: string) => void;
}

export function AddAgentModal({ onClose, onAdded }: AddAgentModalProps) {
  const [catalog, setCatalog] = useState<AddableAgent[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<{ kind: "install"; url: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAgentCatalog()
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.agents);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalogError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return catalog;
    return catalog.filter((a) => searchableText(a).includes(needle));
  }, [catalog, query]);

  const selected = useMemo(
    () => catalog?.find((a) => agentKey(a) === selectedKey) ?? null,
    [catalog, selectedKey],
  );

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    setErrorHint(null);
    try {
      const res = await addAgent({ bundleSlug: selected.bundleSlug, agentId: selected.agentId });
      if (res.ok) {
        const files = (res.changedFiles ?? []).join(", ") || "none";
        onAdded(`Agent ${selected.agentId} added. Changed files: ${files}.`);
        onClose();
        return;
      }
      surfaceError(res as unknown as Record<string, unknown>, setError, setErrorHint);
    } catch (err) {
      if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
        surfaceError(err.payload as Record<string, unknown>, setError, setErrorHint);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
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
        className="panel relative flex max-h-[85vh] w-full max-w-3xl flex-col bg-bg p-5 text-xs"
        role="dialog"
        aria-modal="true"
      >
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide">add agent</h2>
            <p className="mt-1 text-[11px] text-muted">
              {"// pulled from the Render Loops gallery; commits to your managed repo"}
            </p>
          </div>
          <button type="button" onClick={onClose} className="border border-line px-2 py-1 text-xs">
            close
          </button>
        </header>

        {catalogError ? (
          <p className="border border-line p-3 text-[11px]">
            Could not load agent catalog: {catalogError}
          </p>
        ) : !catalog ? (
          <p className="text-muted">Loading catalog…</p>
        ) : catalog.length === 0 ? (
          <p className="text-muted">No addable agents in the catalog yet.</p>
        ) : (
          <>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search by name, runtime, or capability..."
              className="mb-3 w-full border border-line bg-bg p-2"
            />
            <div className="min-h-0 flex-1 overflow-auto pr-1">
              <div className="grid gap-2 md:grid-cols-2">
                {filtered.map((agent) => {
                  const key = agentKey(agent);
                  const isSelected = key === selectedKey;
                  return (
                    <button
                      type="button"
                      key={key}
                      onClick={() => setSelectedKey(key)}
                      className={`flex flex-col items-start gap-1.5 border p-3 text-left transition-colors ${
                        isSelected
                          ? "border-accent bg-accent/5"
                          : "border-line hover:border-accent/60"
                      }`}
                      aria-pressed={isSelected}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="truncate font-mono text-[11px] font-bold">
                          {agent.agentId}
                        </span>
                        <span className="badge shrink-0">{agent.bundleName}</span>
                      </div>
                      <p className="text-[11px] text-muted">
                        {agent.description || "no description"}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {agent.runtimeKinds.map((rt) => (
                          <span key={rt} className="badge">
                            {rt}
                          </span>
                        ))}
                        {agent.workflowTask ? <span className="badge">workflow-task</span> : null}
                      </div>
                      {agent.capabilities.length > 0 ? (
                        <p
                          className="truncate font-mono text-[10px] text-muted"
                          title={agent.capabilities.join(", ")}
                        >
                          {agent.capabilities.join(", ")}
                        </p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {filtered.length === 0 ? (
                <p className="p-4 text-center text-muted">No matches for "{query}".</p>
              ) : null}
            </div>

            {selected ? <SelectedSummary agent={selected} /> : null}
          </>
        )}

        {error ? (
          <p className="mt-3 border border-line p-2 text-[11px]">
            {error}
            {errorHint?.kind === "install" ? (
              <>
                <br />
                <a
                  className="text-accent underline"
                  href={errorHint.url}
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

function SelectedSummary({ agent }: { agent: AddableAgent }) {
  return (
    <div className="mt-3 border border-line p-3 text-[11px]">
      <div className="label mb-1">selected</div>
      <div className="font-mono">
        {agent.bundleName} / {agent.agentId}
      </div>
      <Detail label="capabilities" items={agent.capabilities} />
      <Detail label="env vars added" items={agent.envVars} />
      {agent.workflowTask ? (
        <p className="mt-2 text-muted">
          {"// workflow task — registers on the bundle's Workflow service"}
        </p>
      ) : null}
    </div>
  );
}

function Detail({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mt-1">
      <span className="label">{label}:</span>{" "}
      {items.length === 0 ? <span className="text-muted">none</span> : items.join(", ")}
    </div>
  );
}

function agentKey(agent: AddableAgent): string {
  return `${agent.bundleSlug}::${agent.agentId}`;
}

function searchableText(agent: AddableAgent): string {
  return [
    agent.agentId,
    agent.bundleName,
    agent.bundleSlug,
    agent.description,
    ...agent.runtimeKinds,
    ...agent.capabilities,
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Translate proxy error codes to a human-readable line plus an optional
 * action hint. Keeps the modal in lockstep with the wire shape from
 * `packages/web/src/routes/agent-add.ts` and the wizard's responses.
 */
function surfaceError(
  body: Record<string, unknown>,
  setError: (msg: string) => void,
  setHint: (hint: { kind: "install"; url: string } | null) => void,
): void {
  const code = typeof body.error === "string" ? body.error : null;
  const details = typeof body.details === "string" ? body.details : null;
  const installUrl = typeof body.installUrl === "string" ? body.installUrl : null;

  if (code === "needs_install" && installUrl) {
    setError("The render-harness GitHub App is not installed for this repo yet.");
    setHint({ kind: "install", url: installUrl });
    return;
  }
  if (code === "wizard_shared_secret_not_configured") {
    setError(
      "This deployment can't commit changes — WIZARD_SHARED_SECRET is unset. Open the Config tab to add it.",
    );
    setHint(null);
    return;
  }
  if (code === "repo_locator_missing") {
    setError(
      "Repo metadata is missing (.render-harness/agent.json). This usually means the loop was scaffolded outside the wizard's managed-repo flow.",
    );
    setHint(null);
    return;
  }
  if (code === "wizard_service_not_configured") {
    setError(
      "Wizard service URL is unset on this deployment. Override RENDER_HARNESS_WIZARD_URL only when running a self-hosted wizard.",
    );
    setHint(null);
    return;
  }
  setError(details ?? code ?? "add agent failed");
  setHint(null);
}
