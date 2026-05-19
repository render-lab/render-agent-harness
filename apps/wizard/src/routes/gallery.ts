import type { ResolvedGallery } from "@render-harness/registry/gallery";
import type { Hono } from "hono";
import { listAddableAgents } from "../agent-add.js";
import { OFFICIAL_CAPABILITY_INSTALLS } from "../capability-install.js";

/**
 * GET /api/gallery — returns the resolved gallery the SPA renders.
 * GET /api/agents/catalog — flattened view: one entry per agent inside
 * every bundle gallery entry. Used by the operator UI's Add Agent
 * modal and (later) the wizard's "Add to existing harness" picker.
 * GET /api/gallery/agents/:slug — single resolved gallery entry plus
 * the capability rows it references. Used by the deployed harness's
 * `agent-add` deploy-key path so it can plan an add without growing
 * its own gallery loader.
 * GET /api/capabilities/catalog — every capability pack the wizard
 * knows how to install, with the metadata the operator UI's Install
 * capability modal needs (label, description, env vars, write/connector
 * flags, caveats).
 *
 * All four responses are cached at registration time; both the
 * gallery and OFFICIAL_CAPABILITY_INSTALLS are immutable for the
 * lifetime of the process.
 */
export function registerGalleryRoute(app: Hono, gallery: ResolvedGallery): void {
  const addable = listAddableAgents(gallery);
  const capabilityCatalog = buildCapabilityCatalog();
  // Pre-index by slug so the single-entry endpoint is O(1) and
  // payload-shape changes only need one update site.
  const entryBySlug = new Map(gallery.agents.map((entry) => [entry.slug, entry]));
  app.get("/api/gallery", (c) => c.json(gallery));
  app.get("/api/agents/catalog", (c) => c.json({ agents: addable }));
  app.get("/api/gallery/agents/:slug", (c) => {
    const slug = c.req.param("slug");
    const entry = entryBySlug.get(slug);
    if (!entry) {
      return c.json({ error: "gallery_entry_not_found", slug }, 404);
    }
    // Return only the capability rows this entry cites. Keeps the
    // payload small; the harness reassembles a synthetic
    // `ResolvedGallery` from { entry, capabilities } to feed planAgentAdd.
    const cited = new Set(entry.capabilities);
    const capabilities = gallery.capabilities.filter((cap) => cited.has(cap.pack));
    return c.json({ entry, capabilities });
  });
  app.get("/api/capabilities/catalog", (c) => c.json({ capabilities: capabilityCatalog }));
}

export interface CapabilityCatalogEntry {
  pack: string;
  label: string;
  description: string;
  /** Env var names the operator must set on the harness service. */
  envVars: string[];
  /** True when the pack ships write tools the operator can opt into. */
  hasWriteTools: boolean;
  /** True when the pack is a connector (mounts a /connectors/<key> route). */
  isConnector: boolean;
  /** Optional caveat to surface in the modal next to the cap label. */
  caveat: string | null;
}

function buildCapabilityCatalog(): CapabilityCatalogEntry[] {
  return Object.values(OFFICIAL_CAPABILITY_INSTALLS)
    .map((spec) => ({
      pack: spec.pack,
      label: spec.label,
      description: spec.description,
      envVars: [...spec.envVars],
      hasWriteTools: spec.writeTools.length > 0,
      isConnector: spec.connector,
      caveat: spec.caveat ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
