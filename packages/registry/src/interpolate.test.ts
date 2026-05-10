import { describe, expect, it } from "vitest";
import { interpolate, interpolateTree } from "./interpolate.js";

describe("interpolate", () => {
  it("replaces simple placeholders", () => {
    expect(interpolate("Bearer ${TOKEN}", (n) => (n === "TOKEN" ? "abc" : undefined))).toBe(
      "Bearer abc",
    );
  });

  it("uses fallback when env is unset", () => {
    expect(interpolate("${X:-fallback}", () => undefined)).toBe("fallback");
  });

  it("throws on missing required vars", () => {
    expect(() => interpolate("${MISSING}", () => undefined)).toThrow(/missing required env var/);
  });

  it("respects backslash escaping", () => {
    expect(interpolate("\\${X}", () => "should-not-resolve")).toBe("${X}");
  });
});

describe("interpolateTree", () => {
  it("walks nested objects and arrays", () => {
    const env: Record<string, string> = { K: "v" };
    const out = interpolateTree(
      {
        a: "${K}",
        b: ["${K}", { c: "${K}" }],
        n: 42,
      },
      (n) => env[n],
    );
    expect(out).toEqual({ a: "v", b: ["v", { c: "v" }], n: 42 });
  });
});
