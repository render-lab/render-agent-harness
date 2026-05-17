import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLinearWebhook } from "./verify.js";

describe("verifyLinearWebhook", () => {
  it("accepts a valid Linear signature", () => {
    const rawBody = JSON.stringify({ type: "Issue", data: { id: "LIN-1" } });
    const secret = "linear-secret";
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(verifyLinearWebhook({ rawBody, secret, signature })).toBe(true);
  });

  it("rejects invalid signatures", () => {
    expect(
      verifyLinearWebhook({
        rawBody: "{}",
        secret: "linear-secret",
        signature: "bad",
      }),
    ).toBe(false);
  });
});
