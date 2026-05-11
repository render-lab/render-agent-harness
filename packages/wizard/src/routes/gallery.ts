import type { ResolvedGallery } from "@render-harness/registry/gallery";
import type { Hono } from "hono";

/**
 * GET /api/gallery — returns the resolved gallery the SPA renders.
 *
 * Cached at registration time; the gallery is immutable for the
 * lifetime of the process (it's loaded from the bundled snapshot,
 * which is baked into the npm tarball).
 */
export function registerGalleryRoute(app: Hono, gallery: ResolvedGallery): void {
  app.get("/api/gallery", (c) => c.json(gallery));
}
