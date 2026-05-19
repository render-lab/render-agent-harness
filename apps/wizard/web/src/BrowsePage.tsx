import type { ComponentType, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  LuArrowRight,
  LuBot,
  LuBoxes,
  LuCalendarClock,
  LuChevronLeft,
  LuChevronRight,
  LuChevronsLeft,
  LuChevronsRight,
  LuExternalLink,
  LuGitFork,
  LuGithub,
  LuGlobe,
  LuLayers,
  LuListChecks,
  LuPlus,
  LuPuzzle,
  LuRocket,
  LuSearch,
  LuStar,
  LuTag,
  LuUsers,
  LuX,
} from "react-icons/lu";
import { Markdown } from "./components/Markdown.js";
import { Select, type SelectOption } from "./components/Select.js";
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

type FilterKey =
  | "sources"
  | "runtimeKinds"
  | "surfaces"
  | "audiences"
  | "categories"
  | "capabilities"
  | "kinds";

const FILTERS: { key: FilterKey; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: "sources", label: "source", icon: LuStar },
  { key: "kinds", label: "kind", icon: LuBoxes },
  { key: "runtimeKinds", label: "runtime", icon: LuGlobe },
  { key: "surfaces", label: "surface", icon: LuLayers },
  { key: "audiences", label: "audience", icon: LuUsers },
  { key: "categories", label: "category", icon: LuTag },
  { key: "capabilities", label: "capability", icon: LuPuzzle },
];

export function BrowsePage() {
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<FilterKey, string>>({
    sources: "",
    runtimeKinds: "",
    surfaces: "",
    audiences: "",
    categories: "",
    capabilities: "",
    kinds: "",
  });
  const [signedIn, setSignedIn] = useState(false);
  const [myHarnesses, setMyHarnesses] = useState<MyHarness[]>([]);
  const [catalog, setCatalog] = useState<AddableAgent[]>([]);
  const [addingFor, setAddingFor] = useState<BrowseItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);

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
      if (filters.surfaces) {
        if (item.source !== "official" || !item.surface.includes(filters.surfaces)) return false;
      }
      if (filters.audiences) {
        if (item.source !== "official" || !item.audience.includes(filters.audiences)) return false;
      }
      if (filters.categories) {
        if (item.source !== "community" || !item.categories.includes(filters.categories))
          return false;
      }
      if (filters.capabilities && !item.capabilities.includes(filters.capabilities)) return false;
      if (filters.kinds && itemKind(item) !== filters.kinds) return false;
      if (!normalizedQuery) return true;
      return searchText(item).includes(normalizedQuery);
    });
  }, [browse, filters, query]);

  const setFilter = (key: FilterKey, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  // Reset to the first page whenever the filter/query/page-size shape
  // changes, otherwise the user can land on a page that no longer
  // exists (e.g. filter narrows the result to 3, page=2 is invalid).
  // biome-ignore lint/correctness/useExhaustiveDependencies: filtered.length is the proxy for "result set changed"; we deliberately don't depend on `filtered` itself
  useEffect(() => {
    setPage(0);
  }, [filtered.length, pageSize]);

  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filtered.length);
  const visible = filtered.slice(pageStart, pageEnd);

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
        <span className="label cli-dots">Loading catalog</span>
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
          <a className="btn btn-primary inline-flex items-center gap-2" href="/new">
            <LuRocket aria-hidden />
            Create new
          </a>
        </div>
      </section>

      <section className="panel p-4">
        <label className="grid gap-1" htmlFor="browse-search">
          <span className="label">search</span>
          <span className="relative block">
            <LuSearch
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              id="browse-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="chat, github, cron, repo…"
              className="w-full pl-8"
            />
          </span>
        </label>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          {FILTERS.map((filter) => {
            const FilterIcon = filter.icon;
            const facetValues = browse.facets[filter.key];
            const options: SelectOption<string>[] = [
              { value: "", label: "all", hint: `${facetValues.length}` },
              ...facetValues.map((value) => ({
                value,
                label: labelForFacet(value),
              })),
            ];
            return (
              <div key={filter.key} className="grid min-w-40 flex-1 gap-1">
                <span className="label flex items-center gap-1.5">
                  <FilterIcon aria-hidden />
                  {filter.label}
                </span>
                <Select
                  value={filters[filter.key]}
                  options={options}
                  onChange={(next) => setFilter(filter.key, next)}
                  ariaLabel={`Filter by ${filter.label}`}
                />
              </div>
            );
          })}

          {activeFilterCount > 0 ? (
            <button
              type="button"
              className="btn flex items-center gap-1.5"
              onClick={() =>
                setFilters({
                  sources: "",
                  runtimeKinds: "",
                  surfaces: "",
                  audiences: "",
                  categories: "",
                  capabilities: "",
                  kinds: "",
                })
              }
            >
              <LuX aria-hidden />
              clear ({activeFilterCount})
            </button>
          ) : null}
        </div>

        <p className="mt-4 text-[11px] text-muted">
          {filtered.length === 0 ? "0 of " : `${pageStart + 1}–${pageEnd} of `}
          {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
          {filtered.length !== browse.items.length
            ? ` (filtered from ${browse.items.length})`
            : null}
          {query.trim() ? ` matching “${query.trim()}”` : null}
        </p>
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
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((item) => (
              <BrowseCard
                key={item.id}
                item={item}
                canAddToExisting={signedIn && myHarnesses.length > 0 && isOfficial(item)}
                onAddToExisting={() => setAddingFor(item)}
              />
            ))}
          </div>

          {totalPages > 1 ? (
            <Pagination
              page={safePage}
              totalPages={totalPages}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={setPageSize}
            />
          ) : null}
        </>
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

function isOfficial(item: BrowseItem): boolean {
  return item.source === "official";
}

type PageSize = 12 | 24 | 48;
const DEFAULT_PAGE_SIZE: PageSize = 12;
const PAGE_SIZE_OPTIONS: SelectOption<string>[] = [
  { value: "12", label: "12 / page" },
  { value: "24", label: "24 / page" },
  { value: "48", label: "48 / page" },
];

function Pagination({
  page,
  totalPages,
  pageSize,
  onPage,
  onPageSize,
}: {
  page: number;
  totalPages: number;
  pageSize: PageSize;
  onPage: (next: number) => void;
  onPageSize: (next: PageSize) => void;
}) {
  const atStart = page === 0;
  const atEnd = page >= totalPages - 1;
  return (
    <nav
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-3 border border-line bg-surface p-3 text-[11px]"
      aria-label="Browse pagination"
    >
      <button
        type="button"
        aria-label="First page"
        disabled={atStart}
        onClick={() => onPage(0)}
        className="btn"
      >
        <LuChevronsLeft aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Previous page"
        disabled={atStart}
        onClick={() => onPage(Math.max(0, page - 1))}
        className="btn inline-flex items-center gap-1"
      >
        <LuChevronLeft aria-hidden />
        Prev
      </button>
      <span className="label px-3">
        page {page + 1} / {totalPages}
      </span>
      <button
        type="button"
        aria-label="Next page"
        disabled={atEnd}
        onClick={() => onPage(Math.min(totalPages - 1, page + 1))}
        className="btn inline-flex items-center gap-1"
      >
        Next
        <LuChevronRight aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Last page"
        disabled={atEnd}
        onClick={() => onPage(totalPages - 1)}
        className="btn"
      >
        <LuChevronsRight aria-hidden />
      </button>

      <span aria-hidden className="mx-2 hidden h-5 w-px bg-line sm:inline-block" />

      <div className="w-32">
        <Select
          value={String(pageSize)}
          options={PAGE_SIZE_OPTIONS}
          onChange={(next) => onPageSize(Number(next) as PageSize)}
          ariaLabel="Page size"
        />
      </div>
    </nav>
  );
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
  const SourceIcon = sourceIcon(item.source);
  const KindIcon = kindIcon(kind);
  return (
    <article className="panel group relative flex min-h-96 flex-col p-5 transition-[transform,box-shadow,background-color,border-color] duration-100 hover:-translate-y-px hover:border-accent hover:bg-accent/12 hover:shadow-[3px_3px_0_0_var(--color-accent-deep)]">
      <div className="flex items-start justify-between gap-3">
        <div className="label inline-flex items-center gap-1.5">
          <SourceIcon aria-hidden />
          {item.source}
        </div>
        <span className="badge badge-neutral inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
          <KindIcon aria-hidden />
          {labelForFacet(kind)}
        </span>
      </div>

      <h2 className="mt-2 line-clamp-2 wrap-break-word text-lg font-bold" title={item.name}>
        <a href={detailPathFor(item)} className="hover:underline">
          {item.name}
        </a>
      </h2>

      <p className="mt-4 flex-1 text-sm leading-relaxed text-muted">{item.description}</p>

      <div className="mt-5 flex flex-wrap gap-1.5">
        {item.runtimeKinds.map((runtime) => {
          const Icon = runtimeIcon(runtime);
          return (
            <span key={runtime} className="badge inline-flex items-center gap-1">
              <Icon aria-hidden />
              {runtime}
            </span>
          );
        })}
        {item.source === "official"
          ? [
              ...item.surface.map((s) => (
                <span key={`surface:${s}`} className="badge">
                  {s}
                </span>
              )),
              ...item.audience.map((a) => (
                <span key={`audience:${a}`} className="badge">
                  {a}
                </span>
              )),
            ]
          : item.categories.map((category) => (
              <span key={category} className="badge">
                {category}
              </span>
            ))}
      </div>

      {item.capabilities.length > 0 ? (
        <p
          className="mt-4 flex items-center gap-1.5 truncate font-mono text-[10px] text-muted"
          title={item.capabilities.join(", ")}
        >
          <LuPuzzle aria-hidden className="shrink-0" />
          <span className="truncate">{item.capabilities.join(", ")}</span>
        </p>
      ) : null}

      {item.source === "community" ? (
        <p
          className="mt-2 flex items-center gap-1.5 truncate font-mono text-[10px] text-muted"
          title={item.repo}
        >
          <LuGithub aria-hidden className="shrink-0" />
          <span className="truncate">
            {stripProtocol(item.repo)}@{item.ref.slice(0, 7)}
          </span>
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <a className="btn inline-flex items-center gap-1.5" href={detailPathFor(item)}>
          <LuArrowRight aria-hidden />
          Details
        </a>
        {item.source === "official" ? (
          (() => {
            // Atomic entries + has-harnesses → promote "Add to existing"
            // since the user already has somewhere natural to put a
            // single agent. Bundle entries keep "Start from template"
            // primary because bundles imply a fresh deploy (shared caps,
            // service layout, multiple infra services).
            const promoteAdd = canAddToExisting && item.kind === "agent";
            const startTemplate = (
              <a
                className={`btn ${promoteAdd ? "" : "btn-primary"} inline-flex items-center gap-1.5`}
                href={`/new?template=${encodeURIComponent(item.templateSlug)}`}
              >
                <LuRocket aria-hidden />
                Start from template
              </a>
            );
            const addToExisting = canAddToExisting ? (
              <button
                type="button"
                className={`btn ${promoteAdd ? "btn-primary" : ""} inline-flex items-center gap-1.5`}
                onClick={onAddToExisting}
              >
                <LuPlus aria-hidden />
                Add to existing
              </button>
            ) : null;
            return promoteAdd ? (
              <>
                {addToExisting}
                {startTemplate}
              </>
            ) : (
              <>
                {startTemplate}
                {addToExisting}
              </>
            );
          })()
        ) : (
          <>
            <a
              className="btn btn-primary inline-flex items-center gap-1.5"
              href={item.deployUrl}
              target="_blank"
              rel="noreferrer"
            >
              <LuExternalLink aria-hidden />
              Deploy to Render
            </a>
            <a
              className="btn inline-flex items-center gap-1.5"
              href={item.repo}
              target="_blank"
              rel="noreferrer"
            >
              <LuGithub aria-hidden />
              Repo
            </a>
          </>
        )}
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

  const agentOptions: SelectOption<string>[] = bundleAgents.map((a) => ({
    value: a.agentId,
    label: a.agentId,
    hint: a.runtimeKinds.join(", "),
  }));

  const harnessOptions: SelectOption<string>[] = harnesses.map((h) => ({
    value: `${h.org}/${h.repo}`,
    label: (
      <span className="inline-flex items-center gap-1.5">
        <LuGithub aria-hidden />
        {h.org}/{h.repo}
      </span>
    ),
  }));

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
          <h2 className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide">
            <LuPlus aria-hidden className="text-accent" />
            add agent from {item.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 border border-line px-2 py-1 text-xs"
          >
            <LuX aria-hidden />
            close
          </button>
        </header>

        {bundleAgents.length === 0 ? (
          <p className="text-muted">
            This entry has no addable agents yet (the catalog hasn't surfaced any agents under slug
            "{bundleSlug}").
          </p>
        ) : (
          <>
            {/* For atomic entries the agent picker is one-item and looks  */}
            {/* weird; show a static line instead so the user can confirm  */}
            {/* what they're adding before picking a harness.              */}
            {bundleAgents.length === 1 ? (
              <p className="mb-3 text-muted">
                Adding agent{" "}
                <span className="font-mono text-accent">{bundleAgents[0]?.agentId}</span> (
                {bundleAgents[0]?.runtimeKinds.join(", ")}) from{" "}
                <span className="font-mono">{item.name}</span>.
              </p>
            ) : (
              <>
                <span className="label mb-1 block">pick an agent</span>
                <Select
                  value={agentId}
                  options={agentOptions}
                  onChange={setAgentId}
                  ariaLabel="Pick an agent"
                />
              </>
            )}

            <span className="label mb-1 mt-3 block">target harness</span>
            <Select
              value={harnessKey}
              options={harnessOptions}
              onChange={setHarnessKey}
              ariaLabel="Target harness"
            />
          </>
        )}

        {error ? <p className="mt-3 border border-line p-2 text-[11px]">{error}</p> : null}

        <footer className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 border border-line px-3 py-1.5"
          >
            <LuX aria-hidden />
            cancel
          </button>
          <button
            type="button"
            disabled={submitting || !agentId || !selectedHarness}
            onClick={submit}
            className="inline-flex items-center gap-1.5 border border-accent bg-accent px-3 py-1.5 text-canvas disabled:opacity-50"
          >
            <LuPlus aria-hidden />
            {submitting ? "adding…" : "commit add"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function BrowseDetail({ item }: { item: BrowseItem }) {
  const kind = itemKind(item);
  const SourceIcon = sourceIcon(item.source);
  const KindIcon = kindIcon(kind);
  return (
    <div className="space-y-6">
      <a className="btn inline-flex items-center gap-1.5" href="/browse">
        <LuArrowRight aria-hidden className="rotate-180" />
        Back to browse
      </a>

      <section className="panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="label inline-flex items-center gap-1.5">
              <SourceIcon aria-hidden />
              {item.source}
            </div>
            <h1 className="mt-2 text-2xl font-bold uppercase tracking-widest">{item.name}</h1>
            <p className="mt-3 max-w-3xl text-sm text-muted">{item.description}</p>
          </div>
          <span className="badge badge-neutral inline-flex items-center gap-1">
            <KindIcon aria-hidden />
            {labelForFacet(kind)}
          </span>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {item.source === "official" ? (
            <a
              className="btn btn-primary inline-flex items-center gap-1.5"
              href={`/new?template=${encodeURIComponent(item.templateSlug)}`}
            >
              <LuRocket aria-hidden />
              Start from template
            </a>
          ) : (
            <>
              <a
                className="btn btn-primary inline-flex items-center gap-1.5"
                href={item.deployUrl}
                target="_blank"
                rel="noreferrer"
              >
                <LuExternalLink aria-hidden />
                Deploy to Render
              </a>
              <a
                className="btn inline-flex items-center gap-1.5"
                href={item.repo}
                target="_blank"
                rel="noreferrer"
              >
                <LuGithub aria-hidden />
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
            <div className="mt-4 max-h-[40rem] overflow-auto border border-line bg-canvas p-4">
              <Markdown>{item.readme}</Markdown>
            </div>
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
        <TagRow label="runtimes" values={item.runtimeKinds} renderValue={renderRuntimeBadge} />
        {item.source === "official" ? (
          <>
            <TagRow label="surface" values={item.surface} />
            <TagRow label="audience" values={item.audience} />
          </>
        ) : (
          <TagRow label="categories" values={item.categories} />
        )}
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

function TagRow({
  label,
  values,
  renderValue,
}: {
  label: string;
  values: string[];
  renderValue?: (value: string) => ReactNode;
}) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mt-1 flex flex-wrap gap-1.5">
        {values.length > 0 ? (
          values.map((value) => (
            <span key={value} className="badge inline-flex items-center gap-1">
              {renderValue ? renderValue(value) : value}
            </span>
          ))
        ) : (
          <span className="text-muted">none</span>
        )}
      </dd>
    </div>
  );
}

function renderRuntimeBadge(value: string): ReactNode {
  const Icon = runtimeIcon(value);
  return (
    <>
      <Icon aria-hidden />
      {value}
    </>
  );
}

function MissingDetail({ source }: { source: BrowseItem["source"] }) {
  return (
    <div className="panel p-8 text-center">
      <div className="label">{"// NOT FOUND"}</div>
      <p className="mt-2 text-sm text-muted">
        No {source} harness matches this detail URL. It may have been renamed or removed.
      </p>
      <a className="btn mt-4 inline-flex items-center gap-1.5" href="/browse">
        <LuArrowRight aria-hidden className="rotate-180" />
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
    ...item.runtimeKinds,
    ...item.capabilities,
  ];
  if (item.source === "official") {
    base.push(...item.surface, ...item.audience);
  } else {
    base.push(...item.categories, item.repo, item.ref);
  }
  return base.join(" ").toLowerCase();
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function sourceIcon(source: BrowseItem["source"]): ComponentType<{ className?: string }> {
  return source === "official" ? LuStar : LuUsers;
}

function kindIcon(kind: string): ComponentType<{ className?: string }> {
  if (kind === "bundle") return LuLayers;
  if (kind === "community") return LuUsers;
  return LuBot;
}

function runtimeIcon(runtime: string): ComponentType<{ className?: string }> {
  switch (runtime) {
    case "web":
      return LuGlobe;
    case "worker":
      return LuListChecks;
    case "cron":
      return LuCalendarClock;
    case "workflows":
      return LuGitFork;
    default:
      return LuTag;
  }
}
