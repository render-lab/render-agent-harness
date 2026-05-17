import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./verify.js";

describe("verifySlackSignature", () => {
  it("accepts a valid Slack signature", () => {
    const rawBody = JSON.stringify({ type: "event_callback" });
    const signingSecret = "secret";
    const timestamp = "12345";
    const base = `v0:${timestamp}:${rawBody}`;
    const signature = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
    expect(
      verifySlackSignature({
        rawBody,
        signingSecret,
        timestamp,
        signature,
        nowSeconds: 12345,
      }),
    ).toBe(true);
  });

  it("rejects stale timestamps", () => {
    expect(
      verifySlackSignature({
        rawBody: "{}",
        signingSecret: "secret",
        timestamp: "1",
        signature: "v0=abc",
        nowSeconds: 1_000,
      }),
    ).toBe(false);
  });
});
