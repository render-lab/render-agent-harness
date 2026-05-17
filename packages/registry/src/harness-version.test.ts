import { describe, expect, it } from "vitest";
import { buildHarnessVersionInfo } from "./harness-version.js";

describe("buildHarnessVersionInfo", () => {
  it("reports ok for one coherent first-party version family", () => {
    const info = buildHarnessVersionInfo({
      declaredRange: "^0.1",
      packageNames: ["@render-harness/core", "@render-harness/web"],
      versions: {
        "@render-harness/core": "0.1.1",
        "@render-harness/web": "0.1.1",
      },
    });
    expect(info.status).toBe("ok");
    expect(info.messages).toEqual([]);
  });

  it("reports incompatible when running version is outside declared range", () => {
    const info = buildHarnessVersionInfo({
      declaredRange: "^0.2",
      packageNames: ["@render-harness/core", "@render-harness/web"],
      versions: {
        "@render-harness/core": "0.1.1",
        "@render-harness/web": "0.1.1",
      },
    });
    expect(info.status).toBe("incompatible");
    expect(info.messages[0]).toMatch(/does not satisfy/);
  });

  it("warns for invalid declared ranges", () => {
    const info = buildHarnessVersionInfo({
      declaredRange: "definitely not semver",
      packageNames: ["@render-harness/core"],
      versions: {
        "@render-harness/core": "0.1.1",
      },
    });
    expect(info.status).toBe("warning");
    expect(info.messages[0]).toMatch(/invalid harnessVersion/);
  });

  it("warns for mixed first-party versions", () => {
    const info = buildHarnessVersionInfo({
      declaredRange: "^0.1",
      packageNames: ["@render-harness/core", "@render-harness/web"],
      versions: {
        "@render-harness/core": "0.1.1",
        "@render-harness/web": "0.2.0",
      },
    });
    expect(info.status).toBe("warning");
    expect(info.messages[0]).toMatch(/mixed versions/);
  });

  it("reports unknown when no versions can be detected", () => {
    const info = buildHarnessVersionInfo({
      declaredRange: "^0.1",
      packageNames: ["@render-harness/core"],
      versions: {},
    });
    expect(info.status).toBe("unknown");
  });
});
