import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("createRateLimiter", () => {
  it("allows up to capacity in a window", () => {
    const now = 1_000_000;
    const limiter = createRateLimiter({ capacity: 3, windowMs: 60_000, now: () => now });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
  });

  it("refills the bucket after the window expires", () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ capacity: 2, windowMs: 60_000, now: () => now });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
    now += 61_000;
    expect(limiter.consume("a")).toBe(true);
  });

  it("tracks distinct keys independently", () => {
    const limiter = createRateLimiter({ capacity: 1, windowMs: 60_000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("b")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
    expect(limiter.consume("b")).toBe(false);
  });
});
