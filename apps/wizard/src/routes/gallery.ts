import type { ResolvedGallery } from "@render-harness/registry/gallery";
import type { Hono } from "hono";
import { listAddableAgents } from "../agent-add.js";
import { OFFICIAL_CAPABILITY_INSTALLS } from "../capability-install.js";

/**
 * GET /api/gallery — returns the resolved gallery the SPA renders.
 * GET /api/agents/catalog — flattened view: one entry per agent inside
 * every bundle gallery entry. Used by the operator UI's Add Agent
 * modal and (later) the wizard's "Add to existing harness" picker.
 * GET /api/capabilities/catalog — every capability pack the wizard
 * knows how to install, with the metadata the operator UI's Install
 * capability modal needs (label, description, env vars, write/connector
 * flags, caveats).
 *
 * All three responses are cached at registration time; both the
 * gallery and OFFICIAL_CAPABILITY_INSTALLS are immutable for the
 * lifetime of the process.
 */
export function registerGalleryRoute(app: Hono, gallery: ResolvedGallery): void {
  const addable = listAddableAgents(gallery);
  const capabilityCatalog = buildCapabilityCatalog();
  app.get("/api/gallery", (c) => c.json(gallery));
  app.get("/api/agents/catalog", (c) => c.json({ agents: addable }));
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
