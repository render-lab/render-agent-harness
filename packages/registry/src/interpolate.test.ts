import { describe, expect, it } from "vitest";
import { interpolate, interpolateTree } from "./interpolate.js";

const placeholder = (name: string) => `$${name}`;

describe("interpolate", () => {
  it("replaces simple placeholders", () => {
    expect(
      interpolate(`Bearer ${placeholder("{TOKEN}")}`, (n) => (n === "TOKEN" ? "abc" : undefined)),
    ).toBe("Bearer abc");
  });

  it("uses fallback when env is unset", () => {
    expect(interpolate(placeholder("{X:-fallback}"), () => undefined)).toBe("fallback");
  });

  it("throws on missing required vars", () => {
    expect(() => interpolate(placeholder("{MISSING}"), () => undefined)).toThrow(
      /missing required env var/,
    );
  });

  it("respects backslash escaping", () => {
    expect(interpolate(`\\${placeholder("{X}")}`, () => "should-not-resolve")).toBe(
      placeholder("{X}"),
    );
  });
});

describe("interpolateTree", () => {
  it("walks nested objects and arrays", () => {
    const env: Record<string, string> = { K: "v" };
    const out = interpolateTree(
      {
        a: placeholder("{K}"),
        b: [placeholder("{K}"), { c: placeholder("{K}") }],
        n: 42,
      },
      (n) => env[n],
    );
    expect(out).toEqual({ a: "v", b: ["v", { c: "v" }], n: 42 });
  });
});
