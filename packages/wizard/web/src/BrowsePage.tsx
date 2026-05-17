import { useEffect, useMemo, useState } from "react";
import { fetchBrowse } from "./lib/api.js";
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

  useEffect(() => {
    fetchBrowse()
      .then(setBrowse)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
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

  return (
    <div className="space-y-6">
      <section className="panel p-6">
        <div className="hr-section">
          <span>{"// BROWSE HARNESSES"}</span>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <h1 className="text-2xl font-bold uppercase tracking-widest">Find a starting point</h1>
            <p className="mt-3 max-w-3xl text-sm text-muted">
              Official templates are maintained with the wizard. Community entries are external
              harness repos pinned to immutable commits.
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

      {filtered.length === 0 ? (
        <EmptyState query={query} communityEntries={browse.community.entryCount} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <BrowseCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function BrowseCard({ item }: { item: BrowseItem }) {
  const kind = itemKind(item);
  return (
    <article className="panel flex min-h-72 flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="label">{item.source === "official" ? "official" : "community"}</div>
          <h2 className="mt-1 truncate text-lg font-bold" title={item.name}>
            {item.name}
          </h2>
        </div>
        <span className="badge badge-fill">{labelForFacet(kind)}</span>
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
        <p className="mt-3 truncate font-mono text-[10px] text-muted" title={item.capabilities.join(", ")}>
          {item.capabilities.join(", ")}
        </p>
      ) : null}

      {item.source === "community" ? (
        <p className="mt-3 truncate font-mono text-[10px] text-muted" title={item.repo}>
          {stripProtocol(item.repo)}@{item.ref.slice(0, 7)}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {item.source === "official" ? (
          <a className="btn btn-primary" href={`/new?template=${encodeURIComponent(item.templateSlug)}`}>
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
    </article>
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
