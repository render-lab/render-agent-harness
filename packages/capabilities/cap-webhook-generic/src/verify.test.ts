import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./verify.js";

describe("verifyWebhookSignature", () => {
  it("accepts a valid HMAC signature", () => {
    const rawBody = JSON.stringify({ hello: "world" });
    const secret = "top-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    expect(
      verifyWebhookSignature({
        rawBody,
        secret,
        signature,
        prefix: "sha256=",
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const secret = "top-secret";
    const signature = createHmac("sha256", secret).update("good").digest("hex");
    expect(
      verifyWebhookSignature({
        rawBody: "bad",
        secret,
        signature,
      }),
    ).toBe(false);
  });

  it("rejects a missing or wrong prefix", () => {
    const rawBody = "payload";
    const secret = "top-secret";
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(
      verifyWebhookSignature({
        rawBody,
        secret,
        signature,
        prefix: "sha256=",
      }),
    ).toBe(false);
  });
});
