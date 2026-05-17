import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CapabilityCatalogSchema,
  loadCapabilityCatalog,
  parseCapabilityCatalogYaml,
  serializeCapabilityCatalog,
} from "./capability-index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..", "..");

describe("CapabilityCatalogSchema", () => {
  it("accepts a minimal capability catalog", () => {
    const parsed = CapabilityCatalogSchema.parse({
      schemaVersion: 1,
      capabilities: [
        {
          package: "@acme/cap-thing",
          name: "Thing",
          description: "Adds thing tools.",
          versionRange: "^0.1",
          features: ["tools"],
        },
      ],
    });
    expect(parsed.capabilities[0]?.trustTier).toBe("community");
    expect(parsed.capabilities[0]?.categories).toEqual([]);
  });

  it("rejects duplicate packages", () => {
    expect(() =>
      CapabilityCatalogSchema.parse({
        schemaVersion: 1,
        capabilities: [
          {
            package: "@acme/cap-thing",
            name: "Thing",
            description: "Adds thing tools.",
            versionRange: "^0.1",
            features: ["tools"],
          },
          {
            package: "@acme/cap-thing",
            name: "Thing again",
            description: "Duplicate.",
            versionRange: "^0.1",
            features: ["skills"],
          },
        ],
      }),
    ).toThrow(/duplicate capability package/);
  });
});

describe("capability catalog fixture", () => {
  it("loads the checked-in catalog", async () => {
    const catalog = await loadCapabilityCatalog(
      resolve(HARNESS_ROOT, "capability-catalog/index.yaml"),
    );
    expect(catalog.capabilities.map((cap) => cap.package)).toEqual([
      "@render-harness/cap-webhook-generic",
      "@render-harness/cap-github",
      "@render-harness/cap-linear",
    ]);
    expect(catalog.capabilities[1]?.connectors[0]?.key).toBe("github");
  });

  it("round-trips through YAML serialization", () => {
    const catalog = parseCapabilityCatalogYaml(`schemaVersion: 1
capabilities:
  - package: "@acme/cap-thing"
    name: Thing
    description: Adds thing tools.
    versionRange: "^0.1"
    features: [tools]
`);
    expect(parseCapabilityCatalogYaml(serializeCapabilityCatalog(catalog))).toEqual(catalog);
  });
});
