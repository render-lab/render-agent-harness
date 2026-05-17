import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedGallery } from "@render-harness/registry/gallery";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildBrowseResponse, registerBrowseRoute, type BrowseResponse } from "./browse.js";

const GALLERY: ResolvedGallery = {
  schemaVersion: 1,
  agents: [
    {
      slug: "chat",
      name: "Chat assistant",
      description: "Minimal chat starter.",
      categories: ["starter"],
      runtimeKinds: ["web"],
      requiresHarness: "^0.1",
      capabilities: ["@render-harness/cap-memory-pg"],
      author: "render-harness",
      kind: "agent",
      manifest: {
        schemaVersion: 1,
        name: "chat",
        description: "Minimal chat starter.",
        agents: [
          {
            id: "chat",
            agent: { kind: "builtin", ref: "chat", systemPrompt: "You are helpful." },
          },
        ],
      },
      readme: "# Chat",
      sourceFiles: {},
    },
  ],
  capabilities: [],
};

describe("GET /api/browse", () => {
  it("returns official entries when the community index is empty", async () => {
    const app = new Hono();
    registerBrowseRoute(app, { gallery: GALLERY, communityIndexPath: null });

    const res = await app.request("/api/browse");
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowseResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      source: "official",
      id: "official:chat",
      templateSlug: "chat",
    });
    expect(body.community.entryCount).toBe(0);
  });

  it("normalizes community entries with deploy metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wizard-browse-"));
    const indexPath = join(dir, "index.json");
    await writeFile(
      indexPath,
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            name: "community-agent",
            description: "A community harness.",
            repo: "https://github.com/example/community-agent",
            ref: "0123456789abcdef0123456789abcdef01234567",
            categories: ["community", "demo"],
          },
        ],
      }),
      "utf8",
    );

    const body = await buildBrowseResponse({ gallery: GALLERY, communityIndexPath: indexPath });
    const community = body.items.find((item) => item.source === "community");
    expect(community).toMatchObject({
      source: "community",
      id: "community:community-agent",
      repo: "https://github.com/example/community-agent",
      ref: "0123456789abcdef0123456789abcdef01234567",
      categories: ["community", "demo"],
    });
    expect(community && community.source === "community" ? community.deployUrl : "").toContain(
      "render.com/deploy",
    );
    expect(body.facets.sources).toEqual(["community", "official"]);
    expect(body.facets.categories).toContain("starter");
    expect(body.facets.categories).toContain("community");
    expect(body.community.entryCount).toBe(1);
  });
});
