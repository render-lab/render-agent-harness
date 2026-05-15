import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltinContext } from "./types.js";
import { webSearchFactory } from "./webSearch.js";

function makeCtx(env: Record<string, string | undefined>): BuiltinContext {
  return { env: env as NodeJS.ProcessEnv } as BuiltinContext;
}

const noopArgs = {
  runId: "r",
  toolCallId: "c",
  signal: new AbortController().signal,
  logger: {} as never,
};

describe("web_search registration", () => {
  it("does not register when no provider env is set", () => {
    const reg = webSearchFactory(makeCtx({}));
    expect(reg.registered).toBe(false);
    if (!reg.registered) {
      expect(reg.reason).toMatch(/EXA_API_KEY|TAVILY_API_KEY|BRAVE_API_KEY/);
    }
  });
});

describe("web_search Exa provider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls api.exa.ai with the query and key", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ title: "Hello", url: "https://example.com", text: "hi" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const reg = webSearchFactory(makeCtx({ EXA_API_KEY: "k_exa" }));
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({ input: { query: "node" }, ...noopArgs });
    expect(out.content).toMatch(/Hello/);
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs?.[0]).toBe("https://api.exa.ai/search");
    const init = callArgs?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k_exa");
  });

  it("returns isError on non-2xx", async () => {
    fetchSpy.mockResolvedValue(new Response("bad", { status: 500 }));
    const reg = webSearchFactory(makeCtx({ EXA_API_KEY: "k" }));
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({ input: { query: "x" }, ...noopArgs });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/HTTP 500/);
  });
});

describe("web_search Tavily provider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls api.tavily.com with the api_key in body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ title: "T", url: "https://t.example", content: "c" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const reg = webSearchFactory(makeCtx({ TAVILY_API_KEY: "k_tav" }));
    if (!reg.registered) throw new Error("expected registered");
    await reg.handler.handler({ input: { query: "node" }, ...noopArgs });
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs?.[0]).toBe("https://api.tavily.com/search");
    const init = callArgs?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { api_key: string };
    expect(body.api_key).toBe("k_tav");
  });
});

describe("web_search Brave provider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls Brave with x-subscription-token header", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          web: { results: [{ title: "B", url: "https://b.example", description: "d" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const reg = webSearchFactory(makeCtx({ BRAVE_API_KEY: "k_brave" }));
    if (!reg.registered) throw new Error("expected registered");
    await reg.handler.handler({ input: { query: "node" }, ...noopArgs });
    const callArgs = fetchSpy.mock.calls[0];
    const url = callArgs?.[0] as URL;
    expect(url.toString()).toMatch(/^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
    const init = callArgs?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-subscription-token"]).toBe("k_brave");
  });
});

describe("web_search input validation", () => {
  it("rejects empty query", async () => {
    const reg = webSearchFactory(makeCtx({ EXA_API_KEY: "k" }));
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({ input: { query: "  " }, ...noopArgs });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/missing `query`/);
  });
});
