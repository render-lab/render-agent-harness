import type { ResolvedGallery } from "@render-harness/registry/gallery";
import type { Hono } from "hono";
import { listAddableAgents } from "../agent-add.js";

/**
 * GET /api/gallery — returns the resolved gallery the SPA renders.
 * GET /api/agents/catalog — flattened view: one entry per agent inside
 * every bundle gallery entry. Used by the operator UI's Add Agent
 * modal and (later) the wizard's "Add to existing harness" picker.
 *
 * Both responses are cached at registration time; the gallery is
 * immutable for the lifetime of the process (loaded from the bundled
 * snapshot, baked into the npm tarball).
 */
export function registerGalleryRoute(app: Hono, gallery: ResolvedGallery): void {
  const addable = listAddableAgents(gallery);
  app.get("/api/gallery", (c) => c.json(gallery));
  app.get("/api/agents/catalog", (c) => c.json({ agents: addable }));
}
