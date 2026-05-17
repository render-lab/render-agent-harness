import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { definePack } from "./capability.js";
import {
  validateCapabilityCatalog,
  validateCapabilityPack,
  validateCapabilityPackageMetadata,
  validateConnectorKey,
} from "./capability-validate.js";

describe("validateCapabilityPackageMetadata", () => {
  it("accepts required community package metadata", () => {
    const issues = validateCapabilityPackageMetadata({
      name: "@acme/cap-thing",
      version: "0.1.0",
      type: "module",
      description: "Thing capability.",
      license: "MIT",
      keywords: ["render-harness-cap"],
      exports: { ".": { import: "./dist/index.js" } },
      renderHarness: { gallery: { label: "Thing" } },
    });
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("requires ESM exports and the render-harness-cap keyword", () => {
    const issues = validateCapabilityPackageMetadata({
      name: "@acme/cap-thing",
      version: "0.1.0",
      type: "commonjs",
      keywords: [],
    });
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["type", "keywords", "exports"]),
    );
  });
});

describe("validateCapabilityPack", () => {
  it("checks pack name against package short name", () => {
    const pack = definePack({ name: "cap-wrong", version: "0.1.0" });
    const issues = validateCapabilityPack(pack, {
      name: "@acme/cap-thing",
      version: "0.1.0",
      type: "module",
    });
    expect(issues.some((issue) => issue.path === "default.name")).toBe(true);
  });
});

describe("validateConnectorKey", () => {
  it("rejects invalid and reserved connector keys", () => {
    expect(validateConnectorKey("GitHub")[0]?.severity).toBe("error");
    expect(validateConnectorKey("runs")[0]?.severity).toBe("error");
    expect(validateConnectorKey("github")).toEqual([]);
  });
});

describe("validateCapabilityCatalog", () => {
  it("rejects duplicate connector keys across packages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-catalog-"));
    await mkdir(dir, { recursive: true });
    const catalogPath = join(dir, "index.yaml");
    await writeFile(
      catalogPath,
      `schemaVersion: 1
capabilities:
  - package: "@acme/cap-one"
    name: One
    description: First pack.
    versionRange: "^0.1"
    features: [connectors]
    connectors:
      - key: same
        auth: hmac
  - package: "@acme/cap-two"
    name: Two
    description: Second pack.
    versionRange: "^0.1"
    features: [connectors]
    connectors:
      - key: same
        auth: hmac
`,
      "utf8",
    );
    const result = await validateCapabilityCatalog({ catalogPath });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("already declared"))).toBe(true);
  });
});
