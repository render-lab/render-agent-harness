import { describe, expect, it, vi } from "vitest";
import { formatGranolaError, granolaFetch } from "./lib.js";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  });
}

describe("granolaFetch", () => {
  it("sends Bearer auth + accept JSON and parses the response body", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("https://public-api.granola.ai/v1/notes?limit=5");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer key_test");
      expect(headers.accept).toBe("application/json");
      return new Response(JSON.stringify({ notes: [{ id: "n1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const res = await granolaFetch<{ notes: Array<{ id: string }> }>({
      apiKey: "key_test",
      path: "/notes",
      query: { limit: 5 },
      fetchImpl: fetchImpl as never,
    });
    expect(res.notes).toEqual([{ id: "n1" }]);
  });

  it("drops empty / undefined query params", async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe("https://public-api.granola.ai/v1/notes?limit=10");
      return new Response("{}", { status: 200 });
    });
    await granolaFetch({
      apiKey: "k",
      path: "/notes",
      query: { since: undefined, until: "", limit: 10 },
      fetchImpl: fetchImpl as never,
    });
  });

  it("retries once on 429 with Retry-After <= 30s", async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(() => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ notes: [] }), { status: 200 });
    });
    await granolaFetch({ apiKey: "k", path: "/notes", fetchImpl: fetchImpl as never });
    expect(calls).toBe(2);
  });

  it("surfaces 401 as GranolaApiError with status set", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ message: "Invalid token" }), { status: 401 }),
    );
    await expect(
      granolaFetch({ apiKey: "k", path: "/notes", fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("formatGranolaError", () => {
  it("rewrites 401 into actionable key-rotation message", () => {
    const err = Object.assign(new Error("x"), { status: 401 });
    const out = formatGranolaError("granola.list_notes", err);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/api[-/]keys/i);
    expect(out.content).toMatch(/GRANOLA_API_KEY/);
  });

  it("rewrites 429 into rate-limit guidance, including retry-after when present", () => {
    const err = Object.assign(new Error("x"), { status: 429, retryAfterSeconds: 12 });
    const out = formatGranolaError("granola.poll_recent", err);
    expect(out.content).toMatch(/rate limit/i);
    expect(out.content).toMatch(/12s/);
  });

  it("passes generic errors through with status + message", () => {
    const err = Object.assign(new Error("x"), {
      status: 500,
      granolaMessage: "internal",
    });
    const out = formatGranolaError("granola.read_note", err);
    expect(out.content).toMatch(/500/);
    expect(out.content).toMatch(/internal/);
  });

  it("handles non-Error throwables", () => {
    const out = formatGranolaError("granola.list_notes", "just a string");
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/just a string/);
  });
});
