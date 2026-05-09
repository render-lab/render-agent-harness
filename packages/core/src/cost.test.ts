import { describe, expect, it } from "vitest";
import { addUsage, estimateCost } from "./cost.js";
import type { ModelSpec } from "./types.js";

describe("estimateCost", () => {
  const sonnet: ModelSpec = {
    provider: "anthropic",
    model: "claude-sonnet-4-7",
  };

  it("uses the model's input/output rates", () => {
    const cost = estimateCost(sonnet, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // Sonnet 4.7: $3 input, $15 output per million.
    expect(cost.inputUsd).toBeCloseTo(3, 5);
    expect(cost.outputUsd).toBeCloseTo(15, 5);
    expect(cost.totalUsd).toBeCloseTo(18, 5);
  });

  it("includes cache read/write when reported", () => {
    const cost = estimateCost(sonnet, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost.cacheUsd).toBeCloseTo(0.3 + 3.75, 5);
  });

  it("falls back to default pricing for unknown models", () => {
    const unknown: ModelSpec = { provider: "openai-compat", model: "weird-model" };
    const cost = estimateCost(unknown, { inputTokens: 1_000_000, outputTokens: 0 });
    // Default fallback is $5 in.
    expect(cost.inputUsd).toBeCloseTo(5, 5);
  });

  it("respects pricing overrides", () => {
    const cost = estimateCost(
      sonnet,
      { inputTokens: 1_000_000, outputTokens: 0 },
      { in: 1, out: 1 },
    );
    expect(cost.inputUsd).toBeCloseTo(1, 5);
  });
});

describe("addUsage", () => {
  it("sums input/output tokens", () => {
    const total = addUsage(
      { inputTokens: 100, outputTokens: 50 },
      { inputTokens: 200, outputTokens: 80 },
    );
    expect(total.inputTokens).toBe(300);
    expect(total.outputTokens).toBe(130);
  });

  it("sums cache fields when present in either operand", () => {
    const total = addUsage(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 10 },
      { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 5 },
    );
    expect(total.cacheReadTokens).toBe(10);
    expect(total.cacheWriteTokens).toBe(5);
  });

  it("omits cache fields when neither operand reports them", () => {
    const total = addUsage(
      { inputTokens: 1, outputTokens: 1 },
      { inputTokens: 1, outputTokens: 1 },
    );
    expect(total.cacheReadTokens).toBeUndefined();
    expect(total.cacheWriteTokens).toBeUndefined();
  });
});
