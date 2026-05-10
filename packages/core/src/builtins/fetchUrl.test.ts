import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock DNS so tests don't depend on network. Public hostnames resolve to a
// public IP; "private.test" resolves to a private one to exercise the
// redirect-to-private-IP guard.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === "example.com" || host === "example.org") {
      return [{ address: "93.184.216.34", family: 4 }];
    }
    if (host === "private.test") {
      return [{ address: "10.0.0.1", family: 4 }];
    }
    throw new Error(`DNS mock: unknown host "${host}"`);
  }),
}));

import { fetchUrlFactory } from "./fetchUrl.js";
import type { BuiltinContext } from "./types.js";

function makeCtx(env: Record<string, string | undefined> = {}): BuiltinContext {
  return {
    env: env as NodeJS.ProcessEnv,
  } as BuiltinContext;
}

const noopArgs = {
  runId: "r",
  toolCallId: "c",
  signal: new AbortController().signal,
  logger: {} as never,
};

async function call(
  input: unknown,
  env: Record<string, string | undefined> = {},
): Promise<{ content: string; isError?: boolean }> {
  const reg = fetchUrlFactory(makeCtx(env));
  if (!reg.registered) throw new Error("expected registered");
  return await reg.handler.handler({ input, ...noopArgs });
}

describe("fetch_url SSRF guard", () => {
  it("rejects loopback IPv4", async () => {
    const out = await call({ url: "http://127.0.0.1/" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/IPv4 loopback/);
  });

  it("rejects 10.0.0.0/8", async () => {
    const out = await call({ url: "http://10.0.0.5/" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/IPv4 private/);
  });

  it("rejects 192.168.0.0/16", async () => {
    const out = await call({ url: "http://192.168.1.1/" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/IPv4 private/);
  });

  it("rejects link-local 169.254.169.254 (cloud metadata)", async () => {
    const out = await call({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/IPv4 linkLocal/);
  });

  it("rejects IPv6 loopback ::1", async () => {
    const out = await call({ url: "http://[::1]/" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/IPv6 loopback/);
  });

  it("rejects IPv6 unique-local fc00::/7", async () => {
    const out = await call({ url: "http://[fd00::1]/" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/IPv6 uniqueLocal/);
  });

  it("rejects IPv4-mapped IPv6 pointing at private space", async () => {
    const out = await call({ url: "http://[::ffff:10.0.0.1]/" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/IPv4 private/);
  });

  it("rejects file:// scheme", async () => {
    const out = await call({ url: "file:///etc/passwd" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/scheme.*not allowed/);
  });

  it("rejects gopher:// scheme", async () => {
    const out = await call({ url: "gopher://example.com/" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/scheme.*not allowed/);
  });

  it("rejects malformed URL", async () => {
    const out = await call({ url: "not a url" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/not a valid URL/);
  });

  it("HARNESS_FETCH_URL_ALLOW_PRIVATE=1 disables the SSRF guard", async () => {
    // Use a mock fetch so we don't actually hit 127.0.0.1.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    try {
      const out = await call(
        { url: "http://127.0.0.1/x" },
        { HARNESS_FETCH_URL_ALLOW_PRIVATE: "1" },
      );
      expect(out.isError).toBeFalsy();
      expect(out.content).toMatch(/hello/);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("fetch_url response handling", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns text body for text/plain", async () => {
    fetchSpy.mockResolvedValue(
      new Response("hello world", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const out = await call({ url: "https://example.com/" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/hello world/);
    expect(out.content).toMatch(/# fetch_url 200 https:\/\/example\.com/);
  });

  it("returns text body for application/json", async () => {
    fetchSpy.mockResolvedValue(
      new Response('{"a":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const out = await call({ url: "https://example.com/api" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/\{"a":1\}/);
  });

  it("returns binary placeholder for image/png", async () => {
    fetchSpy.mockResolvedValue(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const out = await call({ url: "https://example.com/img.png" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/<binary url="https:\/\/example\.com\/img\.png" status=200 content_type="image\/png" size=4>/);
  });

  it("truncates body at HARNESS_FETCH_URL_MAX_BYTES", async () => {
    const big = "x".repeat(2000);
    fetchSpy.mockResolvedValue(
      new Response(big, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const out = await call(
      { url: "https://example.com/big" },
      { HARNESS_FETCH_URL_MAX_BYTES: "1024" },
    );
    expect(out.content).toMatch(/truncated at 1024 bytes/);
  });

  it("marks 4xx responses as errors", async () => {
    fetchSpy.mockResolvedValue(
      new Response("nope", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    );
    const out = await call({ url: "https://example.com/missing" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/# fetch_url 404/);
  });

  it("follows redirects up to the cap", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://example.org/b" } }),
      )
      .mockResolvedValueOnce(
        new Response("final", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    const out = await call({ url: "https://example.com/a" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/# fetch_url 200 https:\/\/example\.org\/b/);
  });

  it("rejects too many redirects", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/loop" } }),
    );
    const out = await call({ url: "https://example.com/loop" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/too many redirects/);
  });

  it("rejects redirect to a private address", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
    );
    const out = await call({ url: "https://example.com/start" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/IPv4 loopback/);
  });

  it("rejects when DNS resolves the host to a private IP", async () => {
    const out = await call({ url: "https://private.test/" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/IPv4 private/);
  });
});

describe("fetch_url input validation", () => {
  it("rejects missing url", async () => {
    const out = await call({});
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/missing or invalid `url`/);
  });
});
