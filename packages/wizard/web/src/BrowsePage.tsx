import { useEffect, useMemo, useState } from "react";
import {
  type AddableAgent,
  fetchBrowse,
  fetchCatalog,
  fetchMe,
  fetchMyHarnesses,
  type MyHarness,
  postAddAgent,
} from "./lib/api.js";
import type { BrowseItem, BrowseResponse } from "./lib/types.js";

type FilterKey = "sources" | "runtimeKinds" | "categories" | "capabilities" | "kinds";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "sources", label: "source" },
  { key: "runtimeKinds", label: "runtime" },
  { key: "categories", label: "category" },
  { key: "capabilities", label: "capability" },
  { key: "kinds", label: "kind" },
];

export function BrowsePage() {
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<FilterKey, string>>({
    sources: "",
    runtimeKinds: "",
    categories: "",
    capabilities: "",
    kinds: "",
  });
  const [signedIn, setSignedIn] = useState(false);
  const [myHarnesses, setMyHarnesses] = useState<MyHarness[]>([]);
  const [catalog, setCatalog] = useState<AddableAgent[]>([]);
  const [addingFor, setAddingFor] = useState<BrowseItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetchBrowse()
      .then(setBrowse)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    (async () => {
      const me = await fetchMe().catch(() => null);
      if (!me) return;
      setSignedIn(true);
      try {
        const [harnesses, catalogList] = await Promise.all([fetchMyHarnesses(), fetchCatalog()]);
        setMyHarnesses(harnesses);
        setCatalog(catalogList);
      } catch {
        // Best-effort: if these fail we just hide the inline CTA.
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const items = browse?.items ?? [];
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filters.sources && item.source !== filters.sources) return false;
      if (filters.runtimeKinds && !item.runtimeKinds.includes(filters.runtimeKinds)) return false;
      if (filters.categories && !item.categories.includes(filters.categories)) return false;
      if (filters.capabilities && !item.capabilities.includes(filters.capabilities)) return false;
      if (filters.kinds && itemKind(item) !== filters.kinds) return false;
      if (!normalizedQuery) return true;
      return searchText(item).includes(normalizedQuery);
    });
  }, [browse, filters, query]);

  const setFilter = (key: FilterKey, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const detailRef = parseDetailRef();

  if (error) {
    return (
      <div className="panel border-err p-6">
        <div className="label text-err">{"// BROWSE LOAD FAILED"}</div>
        <p className="mt-3 text-sm">{error}</p>
      </div>
    );
  }

  if (!browse) {
    return (
      <div className="panel p-6 text-muted">
        <span className="label">Loading catalog…</span>
      </div>
    );
  }

  if (detailRef) {
    const item = browse.items.find((candidate) => matchesDetailRef(candidate, detailRef));
    return item ? <BrowseDetail item={item} /> : <MissingDetail source={detailRef.source} />;
  }

  return (
    <div className="space-y-6">
      <section className="panel p-6">
        <div className="hr-section">
          <span>{"// BROWSE HARNESSES"}</span>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <h1 className="text-2xl font-bold uppercase tracking-widest">Browse harnesses</h1>
            <p className="mt-3 max-w-3xl text-sm text-muted">
              Compare official templates and community submissions. Start from a maintained template
              or deploy a pinned community repo.
            </p>
          </div>
          <a className="btn btn-primary" href="/new">
            Create new
          </a>
        </div>
      </section>

      <section className="panel p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(16rem,1fr)_repeat(5,minmax(8rem,auto))]">
          <label className="grid gap-1">
            <span className="label">search</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="chat, github, cron, repo..."
            />
          </label>
          {FILTERS.map((filter) => (
            <label key={filter.key} className="grid gap-1">
              <span className="label">{filter.label}</span>
              <select
                value={filters[filter.key]}
                onChange={(event) => setFilter(filter.key, event.target.value)}
              >
                <option value="">all</option>
                {browse.facets[filter.key].map((value) => (
                  <option key={value} value={value}>
                    {labelForFacet(value)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      {browse.community.error ? (
        <p className="border border-line p-3 text-[11px] text-muted">
          {`// community registry index could not be loaded: ${browse.community.error}`}
        </p>
      ) : null}

      {notice ? <p className="border border-line p-3 text-[11px] text-muted">{notice}</p> : null}

      {filtered.length === 0 ? (
        <EmptyState query={query} communityEntries={browse.community.entryCount} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <BrowseCard
              key={item.id}
              item={item}
              canAddToExisting={signedIn && myHarnesses.length > 0 && isBundle(item)}
              onAddToExisting={() => setAddingFor(item)}
            />
          ))}
        </div>
      )}

      {addingFor ? (
        <AddToExistingPicker
          item={addingFor}
          harnesses={myHarnesses}
          catalog={catalog}
          onClose={() => setAddingFor(null)}
          onAdded={(message) => {
            setNotice(message);
            setAddingFor(null);
          }}
        />
      ) : null}
    </div>
  );
}

function isBundle(item: BrowseItem): boolean {
  return item.source === "official" && item.kind === "bundle";
}

function BrowseCard({
  item,
  canAddToExisting,
  onAddToExisting,
}: {
  item: BrowseItem;
  canAddToExisting: boolean;
  onAddToExisting: () => void;
}) {
  const kind = itemKind(item);
  return (
    <article className="panel flex min-h-72 flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="label">{item.source === "official" ? "official" : "community"}</div>
          <h2 className="mt-1 truncate text-lg font-bold" title={item.name}>
            <a href={detailPathFor(item)} className="hover:text-accent">
              {item.name}
            </a>
          </h2>
        </div>
        <span className="badge badge-neutral">{labelForFacet(kind)}</span>
      </div>

      <p className="mt-3 flex-1 text-sm text-muted">{item.description}</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {item.runtimeKinds.map((runtime) => (
          <span key={runtime} className="badge">
            {runtime}
          </span>
        ))}
        {item.categories.map((category) => (
          <span key={category} className="badge">
            {category}
          </span>
        ))}
      </div>

      {item.capabilities.length > 0 ? (
        <p
          className="mt-3 truncate font-mono text-[10px] text-muted"
          title={item.capabilities.join(", ")}
        >
          {item.capabilities.join(", ")}
        </p>
      ) : null}

      {item.source === "community" ? (
        <p className="mt-3 truncate font-mono text-[10px] text-muted" title={item.repo}>
          {stripProtocol(item.repo)}@{item.ref.slice(0, 7)}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <a className="btn" href={detailPathFor(item)}>
          Details
        </a>
        {item.source === "official" ? (
          <a
            className="btn btn-primary"
            href={`/new?template=${encodeURIComponent(item.templateSlug)}`}
          >
            Start from template
          </a>
        ) : (
          <>
            <a className="btn btn-primary" href={item.deployUrl}>
              Deploy to Render
            </a>
            <a className="btn" href={item.repo}>
              Repo
            </a>
          </>
        )}
        {canAddToExisting ? (
          <button type="button" className="btn" onClick={onAddToExisting}>
            Add to existing
          </button>
        ) : null}
      </div>
    </article>
  );
}

function AddToExistingPicker({
  item,
  harnesses,
  catalog,
  onClose,
  onAdded,
}: {
  item: BrowseItem;
  harnesses: MyHarness[];
  catalog: AddableAgent[];
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const bundleSlug = item.source === "official" ? item.templateSlug : "";
  // Restrict the agent picker to the agents inside this bundle.
  const bundleAgents = useMemo(
    () => catalog.filter((a) => a.bundleSlug === bundleSlug),
    [catalog, bundleSlug],
  );
  const [agentId, setAgentId] = useState<string>(bundleAgents[0]?.agentId ?? "");
  const [harnessKey, setHarnessKey] = useState<string>(
    harnesses[0] ? `${harnesses[0].org}/${harnesses[0].repo}` : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedHarness = useMemo(
    () => harnesses.find((h) => `${h.org}/${h.repo}` === harnessKey) ?? null,
    [harnesses, harnessKey],
  );

  const submit = async () => {
    if (!agentId || !selectedHarness) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await postAddAgent({
        bundleSlug,
        agentId,
        targetOrg: selectedHarness.org,
        targetRepo: selectedHarness.repo,
      });
      if (res.ok) {
        onAdded(
          `Added ${agentId} to ${selectedHarness.org}/${selectedHarness.repo}. Changed files: ${(res.changedFiles ?? []).join(", ") || "none"}.`,
        );
        return;
      }
      setError(res.details ?? res.error ?? "add failed");
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
          <h2 className="text-sm font-bold uppercase tracking-wide">add agent from {item.name}</h2>
          <button type="button" onClick={onClose} className="border border-line px-2 py-1 text-xs">
            close
          </button>
        </header>

        {bundleAgents.length === 0 ? (
          <p className="text-muted">
            This entry has no addable agents yet (single-agent gallery entries aren't supported as
            v1 add units).
          </p>
        ) : (
          <>
            <label className="label block" htmlFor="picker-agent-id">
              pick an agent
            </label>
            <select
              id="picker-agent-id"
              className="mt-1 w-full border border-line bg-canvas p-2"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {bundleAgents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.agentId} ({a.runtimeKinds.join(", ")})
                </option>
              ))}
            </select>

            <label className="label mt-3 block" htmlFor="picker-harness">
              target harness
            </label>
            <select
              id="picker-harness"
              className="mt-1 w-full border border-line bg-canvas p-2"
              value={harnessKey}
              onChange={(e) => setHarnessKey(e.target.value)}
            >
              {harnesses.map((h) => (
                <option key={`${h.org}/${h.repo}`} value={`${h.org}/${h.repo}`}>
                  {h.org}/{h.repo}
                </option>
              ))}
            </select>
          </>
        )}

        {error ? <p className="mt-3 border border-line p-2 text-[11px]">{error}</p> : null}

        <footer className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-line px-3 py-1.5">
            cancel
          </button>
          <button
            type="button"
            disabled={submitting || !agentId || !selectedHarness}
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

function BrowseDetail({ item }: { item: BrowseItem }) {
  const kind = itemKind(item);
  return (
    <div className="space-y-6">
      <a className="btn" href="/browse">
        Back to browse
      </a>

      <section className="panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="label">{item.source === "official" ? "official" : "community"}</div>
            <h1 className="mt-2 text-2xl font-bold uppercase tracking-widest">{item.name}</h1>
            <p className="mt-3 max-w-3xl text-sm text-muted">{item.description}</p>
          </div>
          <span className="badge badge-neutral">{labelForFacet(kind)}</span>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {item.source === "official" ? (
            <a
              className="btn btn-primary"
              href={`/new?template=${encodeURIComponent(item.templateSlug)}`}
            >
              Start from template
            </a>
          ) : (
            <>
              <a className="btn btn-primary" href={item.deployUrl}>
                Deploy to Render
              </a>
              <a className="btn" href={item.repo}>
                Repo
              </a>
            </>
          )}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="panel p-4">
          <div className="hr-section">
            <span>{"// OVERVIEW"}</span>
          </div>
          {item.source === "official" && item.readme ? (
            <pre className="mt-4 max-h-112 overflow-auto whitespace-pre-wrap border border-line bg-canvas p-3 text-xs">
              {item.readme}
            </pre>
          ) : (
            <p className="mt-4 text-sm text-muted">
              {item.source === "official"
                ? "This official template does not include preview README content yet."
                : "Community entries are external repos. Open the repo to review source files, README, and the pinned deployable commit."}
            </p>
          )}
        </div>

        <aside className="space-y-4">
          <DetailMeta item={item} />
        </aside>
      </section>
    </div>
  );
}

function DetailMeta({ item }: { item: BrowseItem }) {
  return (
    <div className="panel p-4 text-xs">
      <div className="label mb-3">metadata</div>
      <dl className="space-y-3">
        <MetaRow label="source" value={item.source} />
        <MetaRow label="kind" value={labelForFacet(itemKind(item))} />
        {item.author ? <MetaRow label="author" value={item.author} /> : null}
        {item.source === "community" ? (
          <>
            <MetaRow label="repo" value={stripProtocol(item.repo)} />
            <MetaRow label="ref" value={item.ref} />
          </>
        ) : (
          <MetaRow label="template" value={item.templateSlug} />
        )}
        <TagRow label="runtimes" values={item.runtimeKinds} />
        <TagRow label="categories" values={item.categories} />
        <TagRow label="capabilities" values={item.capabilities} />
      </dl>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mt-1 wrap-break-word font-mono">{value}</dd>
    </div>
  );
}

function TagRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mt-1 flex flex-wrap gap-1.5">
        {values.length > 0 ? (
          values.map((value) => (
            <span key={value} className="badge">
              {value}
            </span>
          ))
        ) : (
          <span className="text-muted">none</span>
        )}
      </dd>
    </div>
  );
}

function MissingDetail({ source }: { source: BrowseItem["source"] }) {
  return (
    <div className="panel p-8 text-center">
      <div className="label">{"// NOT FOUND"}</div>
      <p className="mt-2 text-sm text-muted">
        No {source} harness matches this detail URL. It may have been renamed or removed.
      </p>
      <a className="btn mt-4" href="/browse">
        Back to browse
      </a>
    </div>
  );
}

function EmptyState({ query, communityEntries }: { query: string; communityEntries: number }) {
  const hasQuery = query.trim().length > 0;
  const message = hasQuery
    ? "No entries match the current search and filters."
    : communityEntries === 0
      ? "No community submissions yet. Official templates are still available when filters include them."
      : "No entries match the current filters.";
  return (
    <div className="panel p-8 text-center text-muted">
      <div className="label">{"// EMPTY"}</div>
      <p className="mt-2 text-sm">{message}</p>
    </div>
  );
}

function itemKind(item: BrowseItem): string {
  return item.source === "official" ? item.kind : "community";
}

function detailPathFor(item: BrowseItem): string {
  const slug = item.source === "official" ? item.templateSlug : item.name;
  return `/browse/${item.source}/${encodeURIComponent(slug)}`;
}

function parseDetailRef(): { source: BrowseItem["source"]; slug: string } | null {
  const match = window.location.pathname.match(/^\/browse\/(official|community)\/([^/]+)\/?$/);
  if (!match?.[1] || !match[2]) return null;
  return {
    source: match[1] as BrowseItem["source"],
    slug: decodeURIComponent(match[2]),
  };
}

function matchesDetailRef(item: BrowseItem, ref: { source: BrowseItem["source"]; slug: string }) {
  if (item.source !== ref.source) return false;
  return (item.source === "official" ? item.templateSlug : item.name) === ref.slug;
}

function labelForFacet(value: string): string {
  if (value === "agent") return "single-agent";
  return value;
}

function searchText(item: BrowseItem): string {
  const base = [
    item.name,
    item.description,
    item.source,
    itemKind(item),
    item.author ?? "",
    ...item.categories,
    ...item.runtimeKinds,
    ...item.capabilities,
  ];
  if (item.source === "community") base.push(item.repo, item.ref);
  return base.join(" ").toLowerCase();
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
