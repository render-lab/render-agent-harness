/**
 * cap-scrape-firecrawl — wires Firecrawl's MCP server AND adds a
 * `scrape_and_store` LocalToolHandler that calls Firecrawl's REST API
 * directly and persists the result in Postgres for later retrieval.
 *
 * Usage in render-harness.yaml:
 *
 *   capabilities:
 *     - pack: "@render-harness/cap-scrape-firecrawl"
 *       config:
 *         persist: true   # default
 *
 * Surfaces:
 *   - One MCP server `firecrawl` (stdio transport).
 *   - One LocalToolHandler `scrape_and_store` (when `persist: true`).
 *   - One skill (skills/firecrawl-scrape.md).
 *   - envSchema entry for FIRECRAWL_API_KEY.
 *
 * Config keys:
 *   - `apiKeyEnv` (string, default "FIRECRAWL_API_KEY")
 *   - `persist` (boolean, default true) — disable to skip the Postgres
 *     bootstrap and the scrape_and_store tool. Useful when the entry
 *     wants Firecrawl tools but already has its own storage.
 *   - `apiBase` (string, default "https://api.firecrawl.dev") — the
 *     REST base URL. Override for self-hosted Firecrawl.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LocalToolHandler,
  type McpServerConfig,
  type SkillMetadata,
  getPool,
} from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "skills");

interface FirecrawlConfig {
  apiKeyEnv?: string;
  persist?: boolean;
  apiBase?: string;
}

function readConfig(ctx: PackContext) {
  const cfg = ctx.config as FirecrawlConfig;
  return {
    apiKeyEnv: cfg.apiKeyEnv ?? "FIRECRAWL_API_KEY",
    persist: cfg.persist ?? true,
    apiBase: cfg.apiBase ?? "https://api.firecrawl.dev",
  };
}

const SCHEMA_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS firecrawl_scrapes (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL,
  url TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_code INTEGER,
  markdown TEXT,
  raw JSONB,
  CONSTRAINT firecrawl_scrapes_url_run UNIQUE (run_id, url)
);
CREATE INDEX IF NOT EXISTS firecrawl_scrapes_run_idx ON firecrawl_scrapes (run_id);
`;

let bootstrapped = false;
async function ensureSchema(): Promise<void> {
  if (bootstrapped) return;
  const pool = getPool();
  await pool.query(SCHEMA_BOOTSTRAP_SQL);
  bootstrapped = true;
}

const pack = definePack({
  name: "cap-scrape-firecrawl",
  version: "0.1.0",
  envSchema: [
    {
      name: "FIRECRAWL_API_KEY",
      required: true,
      secret: true,
      description: "API key for Firecrawl (https://firecrawl.dev).",
    },
  ],
  mcpServers(ctx: PackContext): McpServerConfig[] {
    const cfg = readConfig(ctx);
    const apiKey = ctx.env(cfg.apiKeyEnv);
    if (!apiKey) {
      throw new Error(
        `cap-scrape-firecrawl: env var ${cfg.apiKeyEnv} is not set. Set it before building or starting the agent.`,
      );
    }
    return [
      {
        name: "firecrawl",
        transport: "stdio",
        command: "npx",
        args: ["-y", "firecrawl-mcp"],
        env: { FIRECRAWL_API_KEY: apiKey },
      },
    ];
  },
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx);
    if (!cfg.persist) return [];
    const apiKey = ctx.env(cfg.apiKeyEnv);
    if (!apiKey) return [];
    const apiBase = cfg.apiBase;

    const scrapeAndStore: LocalToolHandler = {
      definition: {
        name: "scrape_and_store",
        description:
          "Scrape a URL via Firecrawl and persist the rendered markdown + raw JSON to Postgres. Returns the row id and a short excerpt. Use this when you need to come back to the page later in the run.",
        source: "pack:cap-scrape-firecrawl",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", description: "The URL to scrape." },
            timeout_ms: {
              type: "integer",
              description: "Per-request timeout in milliseconds. Defaults to 60000.",
              minimum: 1000,
              maximum: 300000,
            },
          },
          required: ["url"],
        },
      },
      async handler({ input, runId, signal, logger }) {
        const args = (input ?? {}) as { url?: string; timeout_ms?: number };
        if (!args.url || typeof args.url !== "string") {
          return { content: "scrape_and_store: missing or invalid `url`", isError: true };
        }
        await ensureSchema();
        const timeoutMs = args.timeout_ms ?? 60_000;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const onUpstreamAbort = () => ctrl.abort();
        signal.addEventListener("abort", onUpstreamAbort, { once: true });
        try {
          const res = await fetch(`${apiBase}/v1/scrape`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ url: args.url, formats: ["markdown"] }),
            signal: ctrl.signal,
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            logger.warn({ status: res.status, body }, "firecrawl scrape failed");
            return {
              content: `scrape_and_store: firecrawl returned ${res.status}: ${body.slice(0, 500)}`,
              isError: true,
            };
          }
          const json = (await res.json()) as {
            data?: { markdown?: string; metadata?: { statusCode?: number } };
          };
          const markdown = json.data?.markdown ?? "";
          const statusCode = json.data?.metadata?.statusCode ?? null;
          const pool = getPool();
          const insert = await pool.query<{ id: string }>(
            `INSERT INTO firecrawl_scrapes (run_id, url, status_code, markdown, raw)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (run_id, url) DO UPDATE SET
               fetched_at = now(),
               status_code = EXCLUDED.status_code,
               markdown = EXCLUDED.markdown,
               raw = EXCLUDED.raw
             RETURNING id`,
            [runId, args.url, statusCode, markdown, json],
          );
          const rowId = insert.rows[0]?.id ?? "?";
          const excerpt = markdown.slice(0, 1000);
          return {
            content: `Stored as firecrawl_scrapes.id=${rowId}. status=${statusCode ?? "?"}. excerpt:\n\n${excerpt}`,
          };
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            return { content: "scrape_and_store: timed out", isError: true };
          }
          return {
            content: `scrape_and_store: ${(err as Error).message}`,
            isError: true,
          };
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", onUpstreamAbort);
        }
      },
    };
    return [scrapeAndStore];
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    return [
      {
        name: "firecrawl-scrape",
        description: "Use Firecrawl to render a URL into clean markdown and store it.",
        whenToUse:
          "When the user gives you a URL whose content you'll need later in the run, OR you've already searched and want to read the top result. Prefer scrape_and_store over the raw MCP tool when persistence matters.",
        contentPath: join(SKILLS_DIR, "firecrawl-scrape.md"),
      },
    ];
  },
});

export default pack;
