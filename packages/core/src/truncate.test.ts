import { describe, expect, it } from "vitest";
import {
  approximateTokens,
  CHARS_PER_TOKEN_APPROX,
  DEFAULT_MAX_RESULT_TOKENS,
  truncateResult,
} from "./truncate.js";

describe("truncateResult", () => {
  it("returns the original content when under the cap", () => {
    const text = "hello world";
    const r = truncateResult(text, "tc-1");
    expect(r.wasTruncated).toBe(false);
    expect(r.truncated).toBe(text);
    expect(r.fullTokens).toBe(approximateTokens(text));
  });

  it("truncates when over the cap and tells the model how to fetch more", () => {
    const big = "x".repeat((DEFAULT_MAX_RESULT_TOKENS + 500) * CHARS_PER_TOKEN_APPROX);
    const r = truncateResult(big, "tc-42");
    expect(r.wasTruncated).toBe(true);
    expect(r.truncated.length).toBeLessThan(big.length);
    expect(r.truncated).toContain('fetch_full_result("tc-42")');
  });

  it("respects a custom max", () => {
    const text = "abcdefghijklmnop"; // 16 chars ≈ 4 tokens
    const r = truncateResult(text, "tc-99", 2); // cap at 2 tokens
    expect(r.wasTruncated).toBe(true);
    expect(r.truncated.startsWith(text.slice(0, 8))).toBe(true);
  });
});
