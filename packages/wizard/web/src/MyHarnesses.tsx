import { useEffect, useMemo, useState } from "react";
import {
  type AddableAgent,
  type AuthMe,
  fetchCatalog,
  fetchMe,
  fetchMyHarnesses,
  type MyHarness,
  postAddAgent,
} from "./lib/api.js";

type Phase =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "ready"; me: AuthMe; harnesses: MyHarness[]; catalog: AddableAgent[] }
  | { kind: "error"; message: string };

export function MyHarnessesPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [adding, setAdding] = useState<MyHarness | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (!me) {
          setPhase({ kind: "anon" });
          return;
        }
        const [harnesses, catalog] = await Promise.all([fetchMyHarnesses(), fetchCatalog()]);
        if (cancelled) return;
        setPhase({ kind: "ready", me, harnesses, catalog });
      } catch (err) {
        if (cancelled) return;
        setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === "loading") {
    return (
      <div className="panel p-6 text-muted">
        <span className="label">Loading…</span>
      </div>
    );
  }

  if (phase.kind === "anon") {
    return (
      <div className="panel p-8 text-center">
        <div className="label">{"// SIGN IN"}</div>
        <p className="mt-3 text-sm">
          Sign in with GitHub to see harnesses you've scaffolded and add agents to them.
        </p>
        <a className="btn btn-primary mt-4 inline-block" href="/api/auth/login?next=/my">
          Sign in with GitHub
        </a>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="panel border-err p-6">
        <div className="label text-err">{"// LOAD FAILED"}</div>
        <p className="mt-3 text-sm">{phase.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="panel p-6">
        <div className="hr-section">
          <span>{"// MY HARNESSES"}</span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              {phase.me.avatarUrl ? (
                <img
                  src={phase.me.avatarUrl}
                  alt=""
                  width={32}
                  height={32}
                  className="rounded-full border border-line"
                />
              ) : null}
              <h1 className="text-2xl font-bold uppercase tracking-widest">
                {phase.me.login}'s harnesses
              </h1>
            </div>
            <p className="mt-2 text-sm text-muted">
              Add an agent from the catalog into any harness below. The wizard commits the agents[]
              entry, src/&lt;id&gt;.ts, and re-emitted render.yaml to your repo, and Render
              auto-deploys on push.
            </p>
          </div>
          <a className="btn" href="/browse">
            Browse catalog
          </a>
        </div>
      </section>

      {notice ? <p className="border border-line p-3 text-[11px] text-muted">{notice}</p> : null}

      {phase.harnesses.length === 0 ? (
        <div className="panel p-8 text-center text-muted">
          <div className="label">{"// EMPTY"}</div>
          <p className="mt-2 text-sm">
            No harnesses linked to your account yet. Create one from the{" "}
            <a className="text-accent underline" href="/new">
              wizard
            </a>{" "}
            or claim an existing one via the success-screen URL.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {phase.harnesses.map((h) => (
            <HarnessCard key={`${h.org}/${h.repo}`} harness={h} onAdd={() => setAdding(h)} />
          ))}
        </div>
      )}

      {adding ? (
        <AddAgentPicker
          harness={adding}
          catalog={phase.catalog}
          onClose={() => setAdding(null)}
          onAdded={(message) => {
            setNotice(message);
            setAdding(null);
          }}
        />
      ) : null}
    </div>
  );
}

function HarnessCard({ harness, onAdd }: { harness: MyHarness; onAdd: () => void }) {
  return (
    <article className="panel flex flex-col p-4">
      <header className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="label">{harness.role}</div>
          <h2 className="mt-1 truncate text-lg font-bold" title={`${harness.org}/${harness.repo}`}>
            {harness.repo}
          </h2>
          <p className="mt-1 truncate font-mono text-[10px] text-muted">
            {harness.org}/{harness.repo}
          </p>
        </div>
      </header>
      {harness.agentSlug ? (
        <p className="mt-3 text-xs text-muted">scaffold slug: {harness.agentSlug}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <a className="btn" href={`https://github.com/${harness.org}/${harness.repo}`}>
          Repo
        </a>
        <button type="button" className="btn btn-primary" onClick={onAdd}>
          Add agent
        </button>
      </div>
    </article>
  );
}

function AddAgentPicker({
  harness,
  catalog,
  onClose,
  onAdded,
}: {
  harness: MyHarness;
  catalog: AddableAgent[];
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string>(catalog[0] ? agentKey(catalog[0]) : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => catalog.find((a) => agentKey(a) === selectedKey),
    [catalog, selectedKey],
  );

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await postAddAgent({
        bundleSlug: selected.bundleSlug,
        agentId: selected.agentId,
        targetOrg: harness.org,
        targetRepo: harness.repo,
      });
      if (res.ok) {
        onAdded(
          `Added ${selected.agentId} to ${harness.org}/${harness.repo}. Changed files: ${(res.changedFiles ?? []).join(", ") || "none"}.`,
        );
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
        className="panel relative w-full max-w-lg bg-canvas p-5 text-xs"
        role="dialog"
        aria-modal="true"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide">add agent to {harness.repo}</h2>
          <button type="button" onClick={onClose} className="border border-line px-2 py-1 text-xs">
            close
          </button>
        </header>
        {catalog.length === 0 ? (
          <p className="text-muted">No addable agents in the catalog yet.</p>
        ) : (
          <>
            <label className="label block" htmlFor="picker-agent">
              pick an agent
            </label>
            <select
              id="picker-agent"
              className="mt-1 w-full border border-line bg-canvas p-2"
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
            >
              {catalog.map((a) => (
                <option key={agentKey(a)} value={agentKey(a)}>
                  {a.bundleName} / {a.agentId} ({a.runtimeKinds.join(", ")})
                </option>
              ))}
            </select>
            {selected ? (
              <div className="mt-4 border border-line p-3 text-[11px]">
                <p className="font-mono">{selected.description || "no description"}</p>
                <p className="mt-2">
                  <span className="label">runtimes:</span> {selected.runtimeKinds.join(", ")}
                </p>
                <p className="mt-1">
                  <span className="label">capabilities:</span>{" "}
                  {selected.capabilities.length ? selected.capabilities.join(", ") : "none"}
                </p>
                <p className="mt-1">
                  <span className="label">env vars:</span>{" "}
                  {selected.envVars.length ? selected.envVars.join(", ") : "none"}
                </p>
              </div>
            ) : null}
          </>
        )}
        {error ? <p className="mt-3 border border-line p-2 text-[11px]">{error}</p> : null}
        <footer className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-line px-3 py-1.5">
            cancel
          </button>
          <button
            type="button"
            disabled={submitting || !selected}
            onClick={submit}
            className="border border-accent bg-accent px-3 py-1.5 text-canvas disabled:opacity-50"
          >
            {submitting ? "adding…" : "commit add"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function agentKey(agent: AddableAgent): string {
  return `${agent.bundleSlug}::${agent.agentId}`;
}
