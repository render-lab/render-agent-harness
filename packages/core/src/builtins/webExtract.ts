import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `web_extract({ url })` — fetch a web page and return clean Markdown.
 *
 * Provider chain (first match wins):
 *   1. Firecrawl (`FIRECRAWL_API_KEY`) — purpose-built scraper.
 *   2. Exa contents API (`EXA_API_KEY`) — secondary, since Exa search
 *      already requires the same key.
 *
 * Override with `HARNESS_WEB_EXTRACT_PROVIDER=firecrawl|exa`.
 */
export const webExtractFactory: BuiltinFactory = (ctx) => {
  const provider = pickProvider(ctx.env);
  if (!provider) {
    return {
      registered: false,
      name: "web_extract",
      reason: "no extractor configured (set FIRECRAWL_API_KEY or EXA_API_KEY)",
    };
  }
  return {
    registered: true,
    handler: buildHandler(provider),
  };
};

type Provider =
  | { kind: "firecrawl"; apiKey: string }
  | { kind: "exa"; apiKey: string };

function pickProvider(env: NodeJS.ProcessEnv): Provider | null {
  const forced = (env.HARNESS_WEB_EXTRACT_PROVIDER ?? "").toLowerCase().trim();
  if (forced === "firecrawl" && env.FIRECRAWL_API_KEY)
    return { kind: "firecrawl", apiKey: env.FIRECRAWL_API_KEY };
  if (forced === "exa" && env.EXA_API_KEY) return { kind: "exa", apiKey: env.EXA_API_KEY };
  if (forced) return null;

  if (env.FIRECRAWL_API_KEY) return { kind: "firecrawl", apiKey: env.FIRECRAWL_API_KEY };
  if (env.EXA_API_KEY) return { kind: "exa", apiKey: env.EXA_API_KEY };
  return null;
}

function buildHandler(provider: Provider): LocalToolHandler {
  return {
    definition: {
      name: "web_extract",
      description: `Extract the readable content of a web page as Markdown. Uses ${provider.kind}. Use when you need the body of a specific URL — for general search use web_search instead.`,
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to extract." },
        },
        required: ["url"],
      },
    },
    handler: async ({ input, signal }) => {
      const url = ((input as { url?: string } | null)?.url ?? "").trim();
      if (!url) return { content: "web_extract: missing `url`", isError: true };
      try {
        const md = await runProvider(provider, url, signal);
        return { content: md };
      } catch (err) {
        return {
          content: `web_extract (${provider.kind}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

async function runProvider(provider: Provider, url: string, signal: AbortSignal): Promise<string> {
  switch (provider.kind) {
    case "firecrawl":
      return await extractFirecrawl(provider.apiKey, url, signal);
    case "exa":
      return await extractExa(provider.apiKey, url, signal);
  }
}

async function extractFirecrawl(
  apiKey: string,
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ url, formats: ["markdown"] }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as {
    data?: { markdown?: string; metadata?: { title?: string } };
  };
  const md = data.data?.markdown;
  if (!md) throw new Error("response had no markdown body");
  const title = data.data?.metadata?.title;
  return title ? `# ${title}\n\n${md}` : md;
}

async function extractExa(apiKey: string, url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ urls: [url], text: true }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; text?: string }>;
  };
  const result = data.results?.[0];
  if (!result?.text) throw new Error("response had no extracted text");
  return result.title ? `# ${result.title}\n\n${result.text}` : result.text;
}
