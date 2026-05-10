import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `web_search({ query, limit?, ... })` — search the web.
 *
 * Provider chain (first match wins):
 *   1. Exa (`EXA_API_KEY`)
 *   2. Tavily (`TAVILY_API_KEY`)
 *   3. Brave Search (`BRAVE_API_KEY`)
 *
 * Override the chain with `HARNESS_WEB_SEARCH_PROVIDER=exa|tavily|brave`.
 *
 * Returns ranked `{ title, url, snippet }` rows.
 */
export const webSearchFactory: BuiltinFactory = (ctx) => {
  const provider = pickProvider(ctx.env);
  if (!provider) {
    return {
      registered: false,
      name: "web_search",
      reason:
        "no search provider configured (set EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY)",
    };
  }
  return {
    registered: true,
    handler: buildHandler(provider),
  };
};

type Provider =
  | { kind: "exa"; apiKey: string }
  | { kind: "tavily"; apiKey: string }
  | { kind: "brave"; apiKey: string };

function pickProvider(env: NodeJS.ProcessEnv): Provider | null {
  const forced = (env.HARNESS_WEB_SEARCH_PROVIDER ?? "").toLowerCase().trim();
  if (forced === "exa" && env.EXA_API_KEY) return { kind: "exa", apiKey: env.EXA_API_KEY };
  if (forced === "tavily" && env.TAVILY_API_KEY)
    return { kind: "tavily", apiKey: env.TAVILY_API_KEY };
  if (forced === "brave" && env.BRAVE_API_KEY)
    return { kind: "brave", apiKey: env.BRAVE_API_KEY };
  if (forced) return null; // explicit pick failed

  if (env.EXA_API_KEY) return { kind: "exa", apiKey: env.EXA_API_KEY };
  if (env.TAVILY_API_KEY) return { kind: "tavily", apiKey: env.TAVILY_API_KEY };
  if (env.BRAVE_API_KEY) return { kind: "brave", apiKey: env.BRAVE_API_KEY };
  return null;
}

interface Input {
  query?: string;
  limit?: number;
}

interface Result {
  title: string;
  url: string;
  snippet: string;
}

function buildHandler(provider: Provider): LocalToolHandler {
  return {
    definition: {
      name: "web_search",
      description: `Search the web using ${provider.kind}. Returns up to 10 ranked results with title, URL, and snippet. The provider is chosen at boot from EXA_API_KEY / TAVILY_API_KEY / BRAVE_API_KEY (override with HARNESS_WEB_SEARCH_PROVIDER).`,
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Search query.", minLength: 1 },
          limit: {
            type: "integer",
            description: "Max results (1-10, default 5).",
            minimum: 1,
            maximum: 10,
          },
        },
        required: ["query"],
      },
    },
    handler: async ({ input, signal }) => {
      const args = (input ?? {}) as Input;
      const query = (args.query ?? "").trim();
      if (!query) return { content: "web_search: missing `query`", isError: true };
      const limit = Math.max(1, Math.min(10, Math.floor(args.limit ?? 5)));

      try {
        const results = await runProvider(provider, query, limit, signal);
        if (results.length === 0) return { content: `web_search: no results for "${query}"` };
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
        return { content: lines.join("\n\n") };
      } catch (err) {
        return {
          content: `web_search (${provider.kind}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

async function runProvider(
  provider: Provider,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<Result[]> {
  switch (provider.kind) {
    case "exa":
      return await searchExa(provider.apiKey, query, limit, signal);
    case "tavily":
      return await searchTavily(provider.apiKey, query, limit, signal);
    case "brave":
      return await searchBrave(provider.apiKey, query, limit, signal);
  }
}

async function searchExa(
  apiKey: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<Result[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ query, numResults: limit, type: "auto" }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? r.url ?? "(untitled)",
    url: r.url ?? "",
    snippet: (r.text ?? "").slice(0, 280),
  }));
}

async function searchTavily(
  apiKey: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<Result[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: limit, search_depth: "basic" }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? r.url ?? "(untitled)",
    url: r.url ?? "",
    snippet: (r.content ?? "").slice(0, 280),
  }));
}

async function searchBrave(
  apiKey: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<Result[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey,
    },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? r.url ?? "(untitled)",
    url: r.url ?? "",
    snippet: (r.description ?? "").replace(/<[^>]+>/g, "").slice(0, 280),
  }));
}
