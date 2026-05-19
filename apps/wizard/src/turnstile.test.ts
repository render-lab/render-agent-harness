import { describe, expect, it } from "vitest";
import { verifyTurnstile } from "./turnstile.js";

describe("verifyTurnstile", () => {
  it("short-circuits when no secret is configured (dev mode)", async () => {
    const result = await verifyTurnstile({ secret: null, token: "" });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty token when a secret is set", async () => {
    const result = await verifyTurnstile({ secret: "shh", token: "" });
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain("missing-token");
  });

  it("accepts a token when Cloudflare returns success", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 });
    const result = await verifyTurnstile({
      secret: "shh",
      token: "abc",
      fetchFn: fakeFetch,
    });
    expect(result.ok).toBe(true);
  });

  it("surfaces error codes from Cloudflare", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }), {
        status: 200,
      });
    const result = await verifyTurnstile({
      secret: "shh",
      token: "abc",
      fetchFn: fakeFetch,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toEqual(["timeout-or-duplicate"]);
  });
});
