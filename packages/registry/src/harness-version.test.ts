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

  it("accepts patch drift inside the declared range", () => {
    // @render-harness/web cascade-bumps when an internal dep (ui)
    // patches, capability packs version independently — patch-level
    // drift inside `^0.2` is expected and shouldn't fire a warning.
    const info = buildHarnessVersionInfo({
      declaredRange: "^0.2",
      packageNames: ["@render-harness/core", "@render-harness/web", "@render-harness/cap-slack"],
      versions: {
        "@render-harness/core": "0.2.1",
        "@render-harness/web": "0.2.2",
        "@render-harness/cap-slack": "0.2.3",
      },
    });
    expect(info.status).toBe("ok");
    expect(info.messages).toEqual([]);
  });

  it("flags out-of-range packages, not just mixed versions", () => {
    const info = buildHarnessVersionInfo({
      declaredRange: "^0.2",
      packageNames: ["@render-harness/core", "@render-harness/web"],
      versions: {
        "@render-harness/core": "0.2.1",
        "@render-harness/web": "0.1.5",
      },
    });
    expect(info.status).toBe("incompatible");
    expect(info.messages[0]).toMatch(/@render-harness\/web@0\.1\.5/);
    expect(info.messages[0]).toMatch(/does not satisfy/);
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
