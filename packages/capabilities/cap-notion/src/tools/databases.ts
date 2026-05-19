import type { LocalToolHandler } from "@render-harness/core";
import { notionFetch } from "../lib.js";
import { handleNotionError } from "./search.js";

export interface DatabaseToolsOpts {
  accessMode: "read" | "read_write";
}

export function databaseTools(opts: DatabaseToolsOpts): LocalToolHandler[] {
  const tools: LocalToolHandler[] = [queryDatabase()];
  if (opts.accessMode === "read_write") {
    tools.push(createDatabaseRow(), updateDatabaseRow());
  }
  return tools;
}

function queryDatabase(): LocalToolHandler {
  return {
    definition: {
      name: "query_database",
      description:
        "Query a Notion database for rows matching a filter. Returns rows with id, properties, and last_edited_time. The filter shape is a passthrough JSON matching Notion's REST API (see https://developers.notion.com/reference/post-database-query#filter-object); pass `{}` to return all rows up to page_size.",
      source: "pack:cap-notion",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          database_id: { type: "string", minLength: 1 },
          filter: {
            type: "object",
            description: "Notion filter object. Passthrough — no client-side abstraction in v1.",
            additionalProperties: true,
          },
          sorts: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description:
              "Optional Notion sorts array, e.g. [{ property: 'Name', direction: 'ascending' }].",
          },
          page_size: {
            type: "integer",
            description: "Max rows. Default 25, max 100.",
            minimum: 1,
            maximum: 100,
          },
          start_cursor: {
            type: "string",
            description: "Pagination cursor from a previous response.",
          },
        },
        required: ["database_id"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        database_id?: string;
        filter?: Record<string, unknown>;
        sorts?: unknown[];
        page_size?: number;
        start_cursor?: string;
      };
      if (!args.database_id) {
        return { content: "notion.query_database: database_id is required", isError: true };
      }
      if (!secrets) return { content: "notion.query_database: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("notion");
      try {
        const body: Record<string, unknown> = {
          page_size: Math.min(args.page_size ?? 25, 100),
        };
        if (args.filter && Object.keys(args.filter).length > 0) body.filter = args.filter;
        if (args.sorts && args.sorts.length > 0) body.sorts = args.sorts;
        if (args.start_cursor) body.start_cursor = args.start_cursor;
        const res = await notionFetch<{
          results?: Array<{
            id: string;
            properties?: Record<string, unknown>;
            last_edited_time?: string;
          }>;
          has_more?: boolean;
          next_cursor?: string | null;
        }>({
          accessToken: conn.accessToken,
          path: `/databases/${args.database_id}/query`,
          method: "POST",
          body,
        });
        const rows = res.results ?? [];
        if (rows.length === 0) {
          return { content: "notion.query_database: no rows matched" };
        }
        const lines = rows.map((r, i) => {
          const propsStr = JSON.stringify(r.properties ?? {}).slice(0, 500);
          return `${i + 1}. id=${r.id}  last_edited=${r.last_edited_time ?? "?"}\n   props=${propsStr}`;
        });
        const footer = res.has_more
          ? `\n\n(more available; pass start_cursor=${res.next_cursor} to paginate)`
          : "";
        return { content: lines.join("\n\n") + footer };
      } catch (err) {
        return handleNotionError("notion.query_database", err);
      }
    },
  };
}

function createDatabaseRow(): LocalToolHandler {
  return {
    definition: {
      name: "create_database_row",
      description:
        "Insert a new row into a Notion database. `properties` must match the database's schema; query the database first to see existing rows' property shape if unsure.",
      source: "pack:cap-notion",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          database_id: { type: "string", minLength: 1 },
          properties: {
            type: "object",
            description: "Notion properties object matching the database schema.",
            additionalProperties: true,
          },
          children: {
            type: "array",
            description: "Optional Notion block children for the row's page body.",
            items: { type: "object", additionalProperties: true },
          },
        },
        required: ["database_id", "properties"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        database_id?: string;
        properties?: Record<string, unknown>;
        children?: unknown[];
      };
      if (!args.database_id || !args.properties) {
        return {
          content: "notion.create_database_row: database_id and properties are required",
          isError: true,
        };
      }
      if (!secrets) {
        return { content: "notion.create_database_row: no SecretsContext", isError: true };
      }
      const conn = await secrets.requireConnection("notion");
      try {
        const body: Record<string, unknown> = {
          parent: { database_id: args.database_id },
          properties: args.properties,
        };
        if (args.children) body.children = args.children;
        const res = await notionFetch<{ id: string; url?: string }>({
          accessToken: conn.accessToken,
          path: "/pages",
          method: "POST",
          body,
        });
        return {
          content: `notion.create_database_row: created id=${res.id}${res.url ? ` url=${res.url}` : ""}`,
        };
      } catch (err) {
        return handleNotionError("notion.create_database_row", err);
      }
    },
  };
}

function updateDatabaseRow(): LocalToolHandler {
  return {
    definition: {
      name: "update_database_row",
      description:
        "Update properties on a Notion database row (which is just a page whose parent is a database). Pass only the properties you want to change.",
      source: "pack:cap-notion",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          page_id: { type: "string", minLength: 1 },
          properties: {
            type: "object",
            description: "Partial Notion properties object.",
            additionalProperties: true,
          },
        },
        required: ["page_id", "properties"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as { page_id?: string; properties?: Record<string, unknown> };
      if (!args.page_id || !args.properties) {
        return {
          content: "notion.update_database_row: page_id and properties are required",
          isError: true,
        };
      }
      if (!secrets) {
        return { content: "notion.update_database_row: no SecretsContext", isError: true };
      }
      const conn = await secrets.requireConnection("notion");
      try {
        await notionFetch({
          accessToken: conn.accessToken,
          path: `/pages/${args.page_id}`,
          method: "PATCH",
          body: { properties: args.properties },
        });
        return { content: `notion.update_database_row: updated id=${args.page_id}` };
      } catch (err) {
        return handleNotionError("notion.update_database_row", err);
      }
    },
  };
}
