import type {
  ResolvedAgentEntry,
  ResolvedCapabilityEntry,
  ResolvedGallery,
} from "@render-harness/registry/gallery";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type CapabilityCatalogEntry, registerGalleryRoute } from "./gallery.js";

const GALLERY: ResolvedGallery = {
  schemaVersion: 1,
  agents: [],
  capabilities: [],
};

function makeApp(gallery: ResolvedGallery = GALLERY) {
  const app = new Hono();
  registerGalleryRoute(app, gallery);
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

describe("GET /api/gallery/agents/:slug", () => {
  // Minimal fake entries that satisfy the type by structure; the
  // endpoint only reads `slug`, `capabilities`, and forwards the whole
  // record back, so we don't need every field populated.
  const memoryEntry = {
    slug: "chief-of-staff",
    name: "Chief of Staff",
    description: "",
    surface: [],
    audience: [],
    runtimeKinds: [],
    capabilities: ["@render-harness/cap-memory-pg", "@render-harness/cap-google"],
    author: null,
    kind: "bundle",
    manifest: { agents: [] },
    sourceFiles: {},
    readme: null,
  } as unknown as ResolvedAgentEntry;
  const otherEntry = {
    slug: "support-bot",
    name: "Support bot",
    description: "",
    surface: [],
    audience: [],
    runtimeKinds: [],
    capabilities: ["@render-harness/cap-slack"],
    author: null,
    kind: "agent",
    manifest: { agents: [] },
    sourceFiles: {},
    readme: null,
  } as unknown as ResolvedAgentEntry;
  const memoryCap = {
    pack: "@render-harness/cap-memory-pg",
    versionRange: "^0.6.0",
    description: "",
    label: "Memory (Postgres)",
    envHint: null,
  } as ResolvedCapabilityEntry;
  const googleCap = {
    pack: "@render-harness/cap-google",
    versionRange: "^0.6.0",
    description: "",
    label: "Google",
    envHint: null,
  } as ResolvedCapabilityEntry;
  const slackCap = {
    pack: "@render-harness/cap-slack",
    versionRange: "^0.6.0",
    description: "",
    label: "Slack",
    envHint: null,
  } as ResolvedCapabilityEntry;
  const FIXTURE: ResolvedGallery = {
    schemaVersion: 1,
    agents: [memoryEntry, otherEntry],
    capabilities: [memoryCap, googleCap, slackCap],
  };

  it("returns the matching entry + only the capabilities it cites", async () => {
    const app = makeApp(FIXTURE);
    const res = await app.request("/api/gallery/agents/chief-of-staff");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entry: ResolvedAgentEntry;
      capabilities: ResolvedCapabilityEntry[];
    };
    expect(body.entry.slug).toBe("chief-of-staff");
    const packs = body.capabilities.map((c) => c.pack).sort();
    expect(packs).toEqual(["@render-harness/cap-google", "@render-harness/cap-memory-pg"]);
    // Slack is in the gallery but not cited by this entry — must be filtered out.
    expect(packs).not.toContain("@render-harness/cap-slack");
  });

  it("returns 404 with the slug echoed when the entry is not found", async () => {
    const app = makeApp(FIXTURE);
    const res = await app.request("/api/gallery/agents/no-such-entry");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; slug: string };
    expect(body.error).toBe("gallery_entry_not_found");
    expect(body.slug).toBe("no-such-entry");
  });
});
