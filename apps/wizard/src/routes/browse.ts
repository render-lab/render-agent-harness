import { readFile } from "node:fs/promises";
import { type IndexEntry, parseIndexJson } from "@render-harness/registry";
import type { ResolvedAgentEntry, ResolvedGallery } from "@render-harness/registry/gallery";
import type { Hono } from "hono";
import { buildDeployUrl } from "../github-app.js";

export type BrowseItem =
  | {
      source: "official";
      id: string;
      name: string;
      description: string;
      /**
       * Standardized closed-set taxonomy authored in `gallery/index.yaml`.
       * Replaced the old `categories: [string]` free-form list in the May
       * 2026 taxonomy migration. Community entries (which come from a
       * separate schema with no migration window) keep `categories[]`.
       */
      surface: string[];
      audience: string[];
      runtimeKinds: string[];
      capabilities: string[];
      author: string | null;
      templateSlug: string;
      kind: "agent" | "bundle";
      readme: string | null;
    }
  | {
      source: "community";
      id: string;
      name: string;
      description: string;
      /** Free-form tags from the community entry's own schema. */
      categories: string[];
      runtimeKinds: string[];
      capabilities: string[];
      author: string | null;
      repo: string;
      ref: string;
      deployUrl: string;
    };

export interface BrowseFacets {
  sources: string[];
  runtimeKinds: string[];
  /** Authored taxonomy facet for official entries. */
  surfaces: string[];
  /** Authored taxonomy facet for official entries. */
  audiences: string[];
  /** Free-form facet derived from community entries only. */
  categories: string[];
  capabilities: string[];
  kinds: string[];
}

export interface BrowseResponse {
  items: BrowseItem[];
  facets: BrowseFacets;
  community: {
    indexConfigured: boolean;
    entryCount: number;
    error: string | null;
  };
}

export interface RegisterBrowseRouteOpts {
  gallery: ResolvedGallery;
  communityIndexPath: string | null;
}

export function registerBrowseRoute(app: Hono, opts: RegisterBrowseRouteOpts): void {
  app.get("/api/browse", async (c) => c.json(await buildBrowseResponse(opts)));
}

export async function buildBrowseResponse(opts: RegisterBrowseRouteOpts): Promise<BrowseResponse> {
  const official = opts.gallery.agents.map(normalizeOfficialEntry);
  const communityResult = await loadCommunityEntries(opts.communityIndexPath);
  const community = communityResult.entries.map(normalizeCommunityEntry);
  const items = [...official, ...community];

  return {
    items,
    facets: buildFacets(items),
    community: {
      indexConfigured: Boolean(opts.communityIndexPath),
      entryCount: community.length,
      error: communityResult.error,
    },
  };
}

function normalizeOfficialEntry(entry: ResolvedAgentEntry): BrowseItem {
  return {
    source: "official",
    id: `official:${entry.slug}`,
    name: entry.name,
    description: entry.description,
    surface: entry.surface,
    audience: entry.audience,
    runtimeKinds: entry.runtimeKinds,
    capabilities: entry.capabilities,
    author: entry.author,
    templateSlug: entry.slug,
    kind: entry.kind,
    readme: entry.readme,
  };
}

function normalizeCommunityEntry(entry: IndexEntry): BrowseItem {
  return {
    source: "community",
    id: `community:${entry.name}`,
    name: entry.name,
    description: entry.description,
    categories: entry.categories ?? [],
    runtimeKinds: [],
    capabilities: [],
    author: null,
    repo: entry.repo,
    ref: entry.ref,
    deployUrl: buildDeployUrl(entry.repo),
  };
}

async function loadCommunityEntries(
  indexPath: string | null,
): Promise<{ entries: IndexEntry[]; error: string | null }> {
  if (!indexPath) return { entries: [], error: null };
  try {
    const text = await readFile(indexPath, "utf8");
    return { entries: parseIndexJson(text).entries, error: null };
  } catch (err) {
    return {
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildFacets(items: BrowseItem[]): BrowseFacets {
  const sources = new Set<string>();
  const runtimeKinds = new Set<string>();
  const surfaces = new Set<string>();
  const audiences = new Set<string>();
  const categories = new Set<string>();
  const capabilities = new Set<string>();
  const kinds = new Set<string>();

  for (const item of items) {
    sources.add(item.source);
    kinds.add(item.source === "official" ? item.kind : "community");
    for (const runtime of item.runtimeKinds) runtimeKinds.add(runtime);
    for (const capability of item.capabilities) capabilities.add(capability);
    if (item.source === "official") {
      for (const s of item.surface) surfaces.add(s);
      for (const a of item.audience) audiences.add(a);
    } else {
      for (const category of item.categories) categories.add(category);
    }
  }

  return {
    sources: [...sources].sort(),
    runtimeKinds: [...runtimeKinds].sort(),
    surfaces: [...surfaces].sort(),
    audiences: [...audiences].sort(),
    categories: [...categories].sort(),
    capabilities: [...capabilities].sort(),
    kinds: [...kinds].sort(),
  };
}
