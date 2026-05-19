import type { LocalToolHandler } from "@render-harness/core";
import { type NotionApiError, notionFetch } from "../lib.js";

export function searchTool(): LocalToolHandler {
  return {
    definition: {
      name: "search",
      description:
        "Search the connected Notion workspace for pages and databases by title. Returns the top matches with id, title, type (page | database), and parent. Use this when the user references a Notion page or database by name and you need its id before calling read_page or query_database.",
      source: "pack:cap-notion",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Free-form search text against page/database titles.",
            minLength: 1,
          },
          filter_type: {
            type: "string",
            enum: ["page", "database"],
            description: "Restrict results to pages OR databases only.",
          },
          page_size: {
            type: "integer",
            description: "Max results. Default 10, max 100.",
            minimum: 1,
            maximum: 100,
          },
        },
        required: ["query"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        query?: string;
        filter_type?: "page" | "database";
        page_size?: number;
      };
      if (!args.query) {
        return { content: "notion.search: query is required", isError: true };
      }
      if (!secrets) {
        return { content: "notion.search: no SecretsContext on this run", isError: true };
      }
      const conn = await secrets.requireConnection("notion");
      try {
        const body: Record<string, unknown> = {
          query: args.query,
          page_size: Math.min(args.page_size ?? 10, 100),
        };
        if (args.filter_type) {
          body.filter = { value: args.filter_type, property: "object" };
        }
        const res = await notionFetch<{ results?: NotionSearchResult[] }>({
          accessToken: conn.accessToken,
          path: "/search",
          method: "POST",
          body,
        });
        const results = res.results ?? [];
        if (results.length === 0) {
          return { content: `notion.search: no matches for "${args.query}"` };
        }
        const lines = results.map((r, i) => formatSearchResult(r, i + 1));
        return { content: lines.join("\n") };
      } catch (err) {
        return handleNotionError("notion.search", err);
      }
    },
  };
}

interface NotionSearchResult {
  id: string;
  object: "page" | "database";
  properties?: Record<string, unknown>;
  title?: Array<{ plain_text?: string }>;
  parent?: { type?: string; page_id?: string; database_id?: string; workspace?: boolean };
  url?: string;
}

function formatSearchResult(r: NotionSearchResult, n: number): string {
  const title = extractTitle(r);
  const parent = formatParent(r.parent);
  return `${n}. [${r.object}] ${title || "(untitled)"}  id=${r.id}${parent ? `  parent=${parent}` : ""}`;
}

function extractTitle(r: NotionSearchResult): string {
  if (r.object === "database" && r.title && r.title.length > 0) {
    return r.title.map((t) => t.plain_text ?? "").join("");
  }
  // Pages: title lives in properties[].title[]
  const props = (r.properties ?? {}) as Record<
    string,
    { type?: string; title?: Array<{ plain_text?: string }> }
  >;
  for (const v of Object.values(props)) {
    if (v.type === "title" && v.title && v.title.length > 0) {
      return v.title.map((t) => t.plain_text ?? "").join("");
    }
  }
  return "";
}

function formatParent(p: NotionSearchResult["parent"]): string {
  if (!p) return "";
  if (p.workspace) return "workspace";
  if (p.type === "page_id" && p.page_id) return `page:${p.page_id}`;
  if (p.type === "database_id" && p.database_id) return `database:${p.database_id}`;
  return p.type ?? "";
}

export function handleNotionError(tool: string, err: unknown): { content: string; isError: true } {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as NotionApiError;
    if (e.status === 401 || e.code === "unauthorized") {
      return {
        content: `${tool}: Notion access token rejected (${e.code ?? "unauthorized"}). Ask the user to reconnect at /ui/connections.`,
        isError: true,
      };
    }
    if (e.code === "restricted_resource") {
      return {
        content:
          `${tool}: Notion access is restricted on this resource. The connected integration may not have been added to the page/database — Notion users grant access per resource via the "Add connections" menu. ${e.notionMessage ?? ""}`.trim(),
        isError: true,
      };
    }
    return {
      content: `${tool}: Notion API ${e.status} ${e.code ?? ""}: ${e.notionMessage ?? "unknown"}`,
      isError: true,
    };
  }
  return {
    content: `${tool}: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
  };
}
