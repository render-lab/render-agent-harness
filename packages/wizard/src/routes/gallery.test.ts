import type { ResolvedGallery } from "@render-harness/registry/gallery";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type CapabilityCatalogEntry, registerGalleryRoute } from "./gallery.js";

const GALLERY: ResolvedGallery = {
  schemaVersion: 1,
  agents: [],
  capabilities: [],
};

function makeApp() {
  const app = new Hono();
  registerGalleryRoute(app, GALLERY);
  return app;
}

describe("GET /api/capabilities/catalog", () => {
  it("lists every pack in OFFICIAL_CAPABILITY_INSTALLS with label + envVars + flags", async () => {
    const app = makeApp();
    const res = await app.request("/api/capabilities/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: CapabilityCatalogEntry[] };
    expect(body.capabilities.length).toBeGreaterThanOrEqual(11);
    // Spot-check both old (already-supported) and new (added in this
    // change) packs.
    const slack = body.capabilities.find((c) => c.pack === "@render-harness/cap-slack");
    expect(slack).toBeDefined();
    expect(slack?.isConnector).toBe(true);
    expect(slack?.hasWriteTools).toBe(true);
    expect(slack?.envVars).toContain("SLACK_BOT_TOKEN");

    const exa = body.capabilities.find((c) => c.pack === "@render-harness/cap-search-exa");
    expect(exa).toBeDefined();
    expect(exa?.isConnector).toBe(false);
    expect(exa?.hasWriteTools).toBe(false);
    expect(exa?.envVars).toEqual(["EXA_API_KEY"]);
    expect(exa?.caveat).toMatch(/Exa/);
  });

  it("returns the catalog sorted by label", async () => {
    const app = makeApp();
    const res = await app.request("/api/capabilities/catalog");
    const body = (await res.json()) as { capabilities: CapabilityCatalogEntry[] };
    const labels = body.capabilities.map((c) => c.label);
    const sortedLabels = [...labels].sort((a, b) => a.localeCompare(b));
    expect(labels).toEqual(sortedLabels);
  });
});
