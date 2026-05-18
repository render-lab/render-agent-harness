import { useEffect, useMemo, useState } from "react";
import {
  type AgentSummary,
  ApiError,
  fetchCapabilityCatalog,
  type InstallableCapability,
  installCapability,
} from "../api.js";
import { Select } from "../components/Select.js";

/**
 * Install capability modal — operator UI surface for `POST
 * /capabilities/install`. Loads the catalog of installable packs from
 * the same-origin `/capabilities/catalog` proxy at mount, so the list
 * stays in sync with whatever the wizard's `OFFICIAL_CAPABILITY_INSTALLS`
 * map declares (no hardcoded list to drift).
 *
 * Pack-specific config inputs (e.g. Slack's allowed channels) are
 * gated on the selected pack rather than rendered for every cap.
 */
export function InstallCapabilityModal({
  agents,
  onClose,
  onInstalled,
}: {
  agents: AgentSummary[];
  onClose: () => void;
  onInstalled: (message: string) => void;
}) {
  const [catalog, setCatalog] = useState<InstallableCapability[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState(agents[0]?.name ?? "");
  const [pack, setPack] = useState<string>("");
  const [accessMode, setAccessMode] = useState<"read" | "read_write">("read");
  const [allowedChannels, setAllowedChannels] = useState("");
  const [requireApproval, setRequireApproval] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCapabilityCatalog()
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.capabilities);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalogError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Default `pack` to the first catalog entry once it loads. Kept in a
  // separate effect from the catalog fetch so the linter can verify
  // dependencies without false positives, and so that re-fetching the
  // catalog never silently resets the user's selection.
  useEffect(() => {
    if (!catalog || pack) return;
    const first = catalog[0];
    if (first) setPack(first.pack);
  }, [catalog, pack]);

  const selected = useMemo<InstallableCapability | null>(
    () => catalog?.find((c) => c.pack === pack) ?? null,
    [catalog, pack],
  );

  // Default the access mode for the picked pack. Connectors (slack/
  // github/linear) commonly install read_write; read-only packs (Exa,
  // Tavily, Firecrawl) have no write tools at all so the toggle is moot.
  useEffect(() => {
    if (!selected) return;
    if (!selected.hasWriteTools) setAccessMode("read");
  }, [selected]);

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    setInstallUrl(null);
    try {
      const config: Record<string, unknown> = {};
      if (selected.pack === "@render-harness/cap-slack") {
        const channels = allowedChannels
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (channels.length > 0) config.allowedChannels = channels;
      }
      const res = await installCapability({
        agentId,
        pack: selected.pack,
        accessMode,
        config,
        requireApproval,
      });
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
      if (err instanceof ApiError) {
        setError(err.message);
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
        <span className="label block" id="capability-pack-label">
          capability
        </span>
        <div className="mt-1">
          {catalogError ? (
            <p className="border border-line p-2 text-[11px] text-muted">
              {`// failed to load capability catalog: ${catalogError}`}
            </p>
          ) : catalog === null ? (
            <p className="border border-line p-2 text-[11px] text-muted">
              {"// loading catalog..."}
            </p>
          ) : catalog.length === 0 ? (
            <p className="border border-line p-2 text-[11px] text-muted">
              {"// catalog returned 0 capabilities"}
            </p>
          ) : (
            <Select
              id="capability-pack"
              value={pack}
              onChange={setPack}
              ariaLabel="capability pack"
              options={catalog.map((c) => ({ value: c.pack, label: c.label }))}
            />
          )}
        </div>
        {selected ? (
          <div className="mt-2 border border-line p-2 text-[11px] text-muted">
            <p>{selected.description}</p>
            {selected.envVars.length > 0 ? (
              <p className="mt-1">
                {`env: `}
                <span className="font-mono">{selected.envVars.join(", ")}</span>
              </p>
            ) : null}
            {selected.caveat ? <p className="mt-1">{`// ${selected.caveat}`}</p> : null}
          </div>
        ) : null}
        <span className="label mt-3 block" id="capability-agent-label">
          target agent
        </span>
        <div className="mt-1">
          <Select
            id="capability-agent"
            value={agentId}
            onChange={setAgentId}
            ariaLabel="target agent"
            placeholder={agents.length === 0 ? "no agents available" : "select agent"}
            options={agents.map((agent) => ({ value: agent.name, label: agent.name }))}
          />
        </div>
        {selected?.hasWriteTools ? (
          <>
            <span className="label mt-3 block" id="capability-access-mode-label">
              access mode
            </span>
            <div className="mt-1">
              <Select<"read" | "read_write">
                id="capability-access-mode"
                value={accessMode}
                onChange={setAccessMode}
                ariaLabel="access mode"
                options={[
                  { value: "read", label: "read" },
                  { value: "read_write", label: "read_write" },
                ]}
              />
            </div>
          </>
        ) : null}
        {selected?.pack === "@render-harness/cap-slack" ? (
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
        {selected?.hasWriteTools && accessMode === "read_write" ? (
          <label className="mt-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={requireApproval}
              onChange={(e) => setRequireApproval(e.target.checked)}
            />
            approval required for write tools
          </label>
        ) : null}
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
            disabled={submitting || !agentId || !selected}
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
