import type { LocalToolHandler, Pool } from "@render-harness/core";
import type OpenAI from "openai";

/**
 * Local tools for the citations-monitor agent. The agent never talks to the
 * search engine or Postgres directly; all side effects go through these
 * handlers so we get idempotency, retries, and audit trails for free.
 */

interface ToolDeps {
  pool: Pool;
  searchClient: OpenAI;
  searchModel: string;
}

export function buildCitationsTools(deps: ToolDeps): LocalToolHandler[] {
  return [
    listTrackedQueries(deps),
    querySearchEngine(deps),
    recordAudit(deps),
    summarizeRecentAudits(deps),
  ];
}

function listTrackedQueries(deps: ToolDeps): LocalToolHandler {
  return {
    definition: {
      name: "list_tracked_queries",
      description:
        "Returns the set of queries this monitor audits, with their target brand and notes. Call this once at the start of the run.",
      source: "local",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled_only: {
            type: "boolean",
            description: "If true (default), only returns queries marked enabled.",
            default: true,
          },
        },
      },
    },
    handler: async ({ input }) => {
      const enabledOnly = (input as { enabled_only?: boolean } | null)?.enabled_only ?? true;
      const { rows } = await deps.pool.query<{
        id: string;
        query_text: string;
        target_brand: string;
        notes: string | null;
        enabled: boolean;
      }>(
        `SELECT id, query_text, target_brand, notes, enabled
           FROM aeo_queries
           WHERE $1::boolean = false OR enabled = true
           ORDER BY id ASC`,
        [enabledOnly],
      );
      const payload = rows.map((r) => ({
        id: r.id,
        query: r.query_text,
        target_brand: r.target_brand,
        notes: r.notes,
        enabled: r.enabled,
      }));
      return {
        content: JSON.stringify({ count: payload.length, queries: payload }, null, 2),
      };
    },
  };
}

function querySearchEngine(deps: ToolDeps): LocalToolHandler {
  return {
    definition: {
      name: "query_search_engine",
      description:
        "Sends a tracked query to the configured AI search engine and returns the response text plus any sources. The engine is asked to behave like a search assistant.",
      source: "local",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "The question to ask the search engine, exactly as a user would type it.",
          },
        },
      },
    },
    handler: async ({ input, signal }) => {
      const query = (input as { query?: string } | null)?.query;
      if (!query || typeof query !== "string") {
        return { content: "query_search_engine: missing `query`", isError: true };
      }
      try {
        const completion = await deps.searchClient.chat.completions.create(
          {
            model: deps.searchModel,
            messages: [
              {
                role: "system",
                content:
                  "You are a web search assistant. Answer the user's question concisely. " +
                  "When you reference specific products, services, or sources, name them explicitly. " +
                  "If you have web search tools available, use them. Include a 'Sources:' list at the end with URLs you relied on.",
              },
              { role: "user", content: query },
            ],
          },
          { signal },
        );
        const choice = completion.choices[0];
        const text = choice?.message?.content ?? "";
        const sources = extractSources(text);
        return {
          content: JSON.stringify(
            {
              engine: deps.searchModel,
              text,
              sources,
            },
            null,
            2,
          ),
        };
      } catch (err) {
        return {
          content: `query_search_engine error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

function recordAudit(deps: ToolDeps): LocalToolHandler {
  return {
    definition: {
      name: "record_audit",
      description:
        "Persist an audit row. Call this exactly once per (query_id, run) pair after deciding whether the brand was cited.",
      source: "local",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query_id", "engine", "was_cited", "response_excerpt", "raw_response"],
        properties: {
          query_id: { type: "string" },
          engine: { type: "string" },
          was_cited: { type: "boolean" },
          response_excerpt: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string" },
                title: { type: "string" },
              },
              required: ["url"],
            },
            default: [],
          },
          raw_response: { type: "string" },
        },
      },
    },
    handler: async ({ input, runId, toolCallId }) => {
      const args = input as {
        query_id?: string;
        engine?: string;
        was_cited?: boolean;
        response_excerpt?: string;
        sources?: Array<{ url: string; title?: string }>;
        raw_response?: string;
      } | null;
      if (
        !args?.query_id ||
        !args.engine ||
        typeof args.was_cited !== "boolean" ||
        !args.response_excerpt ||
        !args.raw_response
      ) {
        return { content: "record_audit: missing required fields", isError: true };
      }
      const id = `audit_${toolCallId}`;
      await deps.pool.query(
        `INSERT INTO aeo_audits
           (id, query_id, run_id, engine, was_cited, response_excerpt, sources, raw_response)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          args.query_id,
          runId,
          args.engine,
          args.was_cited,
          args.response_excerpt,
          JSON.stringify(args.sources ?? []),
          args.raw_response,
        ],
      );
      return { content: JSON.stringify({ id, persisted: true }) };
    },
  };
}

function summarizeRecentAudits(deps: ToolDeps): LocalToolHandler {
  return {
    definition: {
      name: "summarize_recent_audits",
      description:
        "Aggregate counts for audits in the current run. Call once at the very end before composing the final summary.",
      source: "local",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["run_id"],
        properties: {
          run_id: { type: "string", description: "The current run id." },
        },
      },
    },
    handler: async ({ input }) => {
      const runId = (input as { run_id?: string } | null)?.run_id;
      if (!runId) return { content: "summarize_recent_audits: missing run_id", isError: true };
      const { rows } = await deps.pool.query<{
        engine: string;
        total: string;
        cited: string;
      }>(
        `SELECT engine,
                COUNT(*)::text AS total,
                SUM(CASE WHEN was_cited THEN 1 ELSE 0 END)::text AS cited
           FROM aeo_audits
           WHERE run_id = $1
           GROUP BY engine`,
        [runId],
      );
      const summary = rows.map((r) => ({
        engine: r.engine,
        total: Number(r.total),
        cited: Number(r.cited),
      }));
      return { content: JSON.stringify({ run_id: runId, by_engine: summary }, null, 2) };
    },
  };
}

function extractSources(text: string): Array<{ url: string }> {
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s)\]]+/g;
  for (const m of text.matchAll(re)) {
    urls.add(m[0]);
  }
  return [...urls].map((url) => ({ url }));
}
