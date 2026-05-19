import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyIntercomSignature } from "./verify.js";

function sign(rawBody: string, clientSecret: string): string {
  return `sha1=${createHmac("sha1", clientSecret).update(rawBody).digest("hex")}`;
}

describe("verifyIntercomSignature", () => {
  const secret = "icl_test_secret";
  const body = JSON.stringify({ type: "notification_event", id: "n_1" });

  it("returns true for a valid HMAC-SHA1 signature", () => {
    const signature = sign(body, secret);
    expect(verifyIntercomSignature({ rawBody: body, clientSecret: secret, signature })).toBe(true);
  });

  it("returns false when signature is missing", () => {
    expect(verifyIntercomSignature({ rawBody: body, clientSecret: secret, signature: null })).toBe(
      false,
    );
  });

  it("returns false when signature lacks the sha1= prefix", () => {
    const signature = sign(body, secret).slice(5); // drop 'sha1='
    expect(verifyIntercomSignature({ rawBody: body, clientSecret: secret, signature })).toBe(false);
  });

  it("returns false when the signature is for a different body", () => {
    const signature = sign(body, secret);
    expect(
      verifyIntercomSignature({
        rawBody: `${body}tampered`,
        clientSecret: secret,
        signature,
      }),
    ).toBe(false);
  });

  it("returns false when the secret is wrong", () => {
    const signature = sign(body, "different-secret");
    expect(verifyIntercomSignature({ rawBody: body, clientSecret: secret, signature })).toBe(false);
  });

  it("constant-time compare doesn't crash on length mismatches", () => {
    expect(
      verifyIntercomSignature({
        rawBody: body,
        clientSecret: secret,
        signature: "sha1=abc",
      }),
    ).toBe(false);
  });
});
