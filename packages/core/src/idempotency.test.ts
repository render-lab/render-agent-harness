import { describe, expect, it } from "vitest";
import { idempotencyKey } from "./idempotency.js";

describe("idempotencyKey", () => {
  it("produces a stable hex digest for the same inputs", () => {
    const a = idempotencyKey("run-1", "tc-abc");
    const b = idempotencyKey("run-1", "tc-abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different keys for different runs", () => {
    expect(idempotencyKey("run-1", "tc-abc")).not.toBe(idempotencyKey("run-2", "tc-abc"));
  });

  it("produces different keys for different tool call ids", () => {
    expect(idempotencyKey("run-1", "tc-abc")).not.toBe(idempotencyKey("run-1", "tc-def"));
  });

  it("does not collide on similar concatenations", () => {
    // "ab" + "c" must not collide with "a" + "bc"
    expect(idempotencyKey("ab", "c")).not.toBe(idempotencyKey("a", "bc"));
  });
});
