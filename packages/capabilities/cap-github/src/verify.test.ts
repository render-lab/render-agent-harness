import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "./verify.js";

describe("verifyGitHubSignature", () => {
  it("accepts a valid GitHub signature", () => {
    const rawBody = JSON.stringify({ action: "opened" });
    const secret = "github-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    expect(verifyGitHubSignature({ rawBody, secret, signature })).toBe(true);
  });

  it("rejects tampered payloads", () => {
    const secret = "github-secret";
    const signature = `sha256=${createHmac("sha256", secret).update("good").digest("hex")}`;
    expect(verifyGitHubSignature({ rawBody: "bad", secret, signature })).toBe(false);
  });
});
