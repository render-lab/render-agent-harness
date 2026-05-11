import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GalleryIndexSchema,
  loadGalleryFromBundle,
  loadGalleryFromSource,
  ResolvedGallerySchema,
  serializeGallery,
} from "./gallery.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..", "..");

describe("GalleryIndexSchema", () => {
  it("accepts a minimal index", () => {
    const parsed = GalleryIndexSchema.parse({
      schemaVersion: 1,
      agents: [
        {
          slug: "chat",
          name: "Chat",
          description: "x",
          path: "./agents/chat",
          runtimeKinds: ["web"],
        },
      ],
    });
    expect(parsed.agents).toHaveLength(1);
  });

  it("rejects duplicate slugs", () => {
    expect(() =>
      GalleryIndexSchema.parse({
        schemaVersion: 1,
        agents: [
          { slug: "a", name: "A", description: "x", path: "./agents/a", runtimeKinds: ["web"] },
          { slug: "a", name: "A2", description: "y", path: "./agents/a2", runtimeKinds: ["cron"] },
        ],
      }),
    ).toThrow(/duplicate gallery agent slug/);
  });

  it("rejects non-relative paths", () => {
    expect(() =>
      GalleryIndexSchema.parse({
        schemaVersion: 1,
        agents: [
          { slug: "a", name: "A", description: "x", path: "/abs/path", runtimeKinds: ["web"] },
        ],
      }),
    ).toThrow();
  });
});

describe("loadGalleryFromSource", () => {
  it("loads the real harness gallery without error", async () => {
    const gallery = await loadGalleryFromSource({ root: HARNESS_ROOT });
    expect(gallery.agents.length).toBeGreaterThan(0);
    for (const a of gallery.agents) {
      expect(a.manifest.name).toBeTruthy();
      expect(a.manifest.runtimes.length).toBeGreaterThan(0);
    }
    // The harness ships six capability packs; assert we found them all.
    expect(gallery.capabilities.length).toBeGreaterThanOrEqual(6);
    for (const c of gallery.capabilities) {
      expect(c.pack).toMatch(/^@render-harness\/cap-/);
      expect(c.label).toBeTruthy();
    }
  });

  it("rejects an index whose runtimeKinds drift from the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "gallery-drift-"));
    try {
      const entryDir = join(root, "gallery", "agents", "wrong");
      await mkdir(entryDir, { recursive: true });
      await writeFile(
        join(root, "gallery", "index.yaml"),
        `schemaVersion: 1
agents:
  - slug: wrong
    name: Wrong
    description: drifted entry
    path: ./agents/wrong
    runtimeKinds: [web, worker]   # declared
`,
        "utf8",
      );
      await writeFile(
        join(entryDir, "render-harness.yaml"),
        `schemaVersion: 1
name: wrong
description: x
harnessVersion: "^0.1"
agent: { kind: builtin, ref: chat, systemPrompt: x }
runtimes: [{ kind: web }]   # actual: only web
model: { provider: anthropic, model: claude-sonnet-4-6 }
`,
        "utf8",
      );
      await mkdir(join(root, "packages", "capabilities"), { recursive: true });

      await expect(loadGalleryFromSource({ root })).rejects.toThrow(/do not match/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bundle round-trip", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gallery-bundle-"));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("serializes and re-loads the live gallery losslessly", async () => {
    const live = await loadGalleryFromSource({ root: HARNESS_ROOT });
    const bundlePath = join(tempDir, "gallery.json");
    await mkdir(dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, serializeGallery(live), "utf8");

    const reloaded = await loadGalleryFromBundle({ path: bundlePath });
    expect(reloaded.agents.length).toBe(live.agents.length);
    expect(reloaded.capabilities.length).toBe(live.capabilities.length);
    expect(reloaded.agents[0]?.manifest.name).toBe(live.agents[0]?.manifest.name);
  });

  it("rejects a bundle that doesn't match ResolvedGallerySchema", async () => {
    const path = join(tempDir, "bogus.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1 }), "utf8");
    await expect(loadGalleryFromBundle({ path })).rejects.toThrow();
  });

  it("ResolvedGallerySchema accepts the serialized output as a schema-only check", () => {
    // Schema-level validation; manifest is z.unknown() at this layer.
    const ok = {
      schemaVersion: 1,
      agents: [
        {
          slug: "x",
          name: "X",
          description: "x",
          categories: [],
          runtimeKinds: ["web"],
          capabilities: [],
          author: null,
          manifest: {},
          readme: null,
        },
      ],
      capabilities: [],
    };
    expect(() => ResolvedGallerySchema.parse(ok)).not.toThrow();
  });
});
