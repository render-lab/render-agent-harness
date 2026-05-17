import { describe, expect, it } from "vitest";
import { enrichGalleryCapabilities } from "./gallery.js";

describe("enrichGalleryCapabilities", () => {
  it("uses capability catalog metadata and appends catalog-only entries", () => {
    const gallery = enrichGalleryCapabilities(
      {
        schemaVersion: 1,
        agents: [],
        capabilities: [
          {
            pack: "@render-harness/cap-github",
            label: "Github",
            description: "old",
            envHint: "GITHUB_TOKEN",
          },
        ],
      },
      {
        schemaVersion: 1,
        capabilities: [
          {
            package: "@render-harness/cap-github",
            name: "GitHub",
            description: "GitHub work-monitoring connector.",
            categories: ["github"],
            versionRange: "^0.1",
            features: ["tools", "connectors"],
            envVars: [
              { name: "GITHUB_TOKEN", required: true, secret: true },
              { name: "GITHUB_WEBHOOK_SECRET", required: true, secret: true },
            ],
            connectors: [{ key: "github", auth: "hmac" }],
            trustTier: "official",
          },
          {
            package: "@acme/cap-thing",
            name: "Thing",
            description: "Community thing.",
            categories: ["thing"],
            versionRange: "^0.1",
            features: ["tools"],
            envVars: [],
            connectors: [],
            trustTier: "community",
          },
        ],
      },
    );

    expect(gallery.capabilities).toEqual([
      {
        pack: "@render-harness/cap-github",
        label: "GitHub",
        description: "GitHub work-monitoring connector.",
        envHint: "GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET",
      },
      {
        pack: "@acme/cap-thing",
        label: "Thing",
        description: "Community thing.",
        envHint: null,
      },
    ]);
  });
});
