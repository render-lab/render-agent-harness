import type { LocalToolHandler } from "@render-harness/core";
import { flattenBlocks, notionFetch } from "../lib.js";
import { handleNotionError } from "./search.js";

interface NotionPage {
  id: string;
  url?: string;
  parent?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  created_time?: string;
  last_edited_time?: string;
}

export interface PageToolsOpts {
  accessMode: "read" | "read_write";
}

export function pageTools(opts: PageToolsOpts): LocalToolHandler[] {
  const tools: LocalToolHandler[] = [readPage()];
  if (opts.accessMode === "read_write") {
    tools.push(createPage(), appendBlocks(), updatePageProperties());
  }
  return tools;
}

function readPage(): LocalToolHandler {
  return {
    definition: {
      name: "read_page",
      description:
        "Read a Notion page's metadata + top-level block content (flattened to markdown-like text). Block-tree depth is capped at 1 in v1 — child pages and sub-blocks are noted with `[has children]` markers; call read_page again on the child id to descend.",
      source: "pack:cap-notion",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          page_id: {
            type: "string",
            description: "Notion page id (UUID-ish, with or without dashes).",
            minLength: 1,
          },
          include_properties: {
            type: "boolean",
            description: "Include the page's database properties in the output. Default true.",
          },
          block_limit: {
            type: "integer",
            description: "Max top-level blocks to fetch. Default 100, max 200.",
            minimum: 1,
            maximum: 200,
          },
        },
        required: ["page_id"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        page_id?: string;
        include_properties?: boolean;
        block_limit?: number;
      };
      if (!args.page_id) return { content: "notion.read_page: page_id is required", isError: true };
      if (!secrets) return { content: "notion.read_page: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("notion");
      try {
        const limit = Math.min(args.block_limit ?? 100, 200);
        const [page, children] = await Promise.all([
          notionFetch<NotionPage>({
            accessToken: conn.accessToken,
            path: `/pages/${args.page_id}`,
          }),
          notionFetch<{ results?: unknown[] }>({
            accessToken: conn.accessToken,
            path: `/blocks/${args.page_id}/children?page_size=${limit}`,
          }),
        ]);
        const parts: string[] = [];
        parts.push(`# page id: ${page.id}`);
        if (page.url) parts.push(`url: ${page.url}`);
        if (page.last_edited_time) parts.push(`last edited: ${page.last_edited_time}`);
        if (args.include_properties !== false && page.properties) {
          parts.push("");
          parts.push("## properties");
          parts.push(JSON.stringify(page.properties, null, 2).slice(0, 4000));
        }
        parts.push("");
        parts.push("## content");
        parts.push(flattenBlocks(children.results ?? []));
        return { content: parts.join("\n") };
      } catch (err) {
        return handleNotionError("notion.read_page", err);
      }
    },
  };
}

function createPage(): LocalToolHandler {
  return {
    definition: {
      name: "create_page",
      description:
        "Create a new Notion page under a parent (page or database). Pass `parent_page_id` to create a child page, or `parent_database_id` + `properties` to create a new row in a database. Optionally pass `children` (array of Notion block objects) to seed the page body.",
      source: "pack:cap-notion",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          parent_page_id: { type: "string" },
          parent_database_id: { type: "string" },
          properties: {
            type: "object",
            description:
              "Notion property object. Required when parent_database_id is set; for parent_page_id, pass at least `{ title: { title: [{ text: { content: '...' } }] } }`.",
            additionalProperties: true,
          },
          children: {
            type: "array",
            description: "Optional array of Notion block objects to seed the page body.",
            items: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        parent_page_id?: string;
        parent_database_id?: string;
        properties?: Record<string, unknown>;
        children?: unknown[];
      };
      if (!args.parent_page_id && !args.parent_database_id) {
        return {
          content: "notion.create_page: one of parent_page_id or parent_database_id is required",
          isError: true,
        };
      }
      if (args.parent_database_id && !args.properties) {
        return {
          content:
            "notion.create_page: properties is required when creating a database row (parent_database_id).",
          isError: true,
        };
      }
      if (!secrets) return { content: "notion.create_page: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("notion");
      try {
        const parent = args.parent_database_id
          ? { database_id: args.parent_database_id }
          : { page_id: args.parent_page_id };
        const body: Record<string, unknown> = { parent, properties: args.properties ?? {} };
        if (args.children) body.children = args.children;
        const res = await notionFetch<NotionPage>({
          accessToken: conn.accessToken,
          path: "/pages",
          method: "POST",
          body,
        });
        return {
          content: `notion.create_page: created id=${res.id}${res.url ? ` url=${res.url}` : ""}`,
        };
      } catch (err) {
        return handleNotionError("notion.create_page", err);
      }
    },
  };
}

function appendBlocks(): LocalToolHandler {
  return {
    definition: {
      name: "append_blocks",
      description:
        "Append Notion block objects to a page or block. Use for adding paragraphs / headings / lists / code blocks to the bottom of a page.",
      source: "pack:cap-notion",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          page_id: {
            type: "string",
            description: "Page (or block) id to append children to.",
            minLength: 1,
          },
          children: {
            type: "array",
            description: "Array of Notion block objects.",
            items: { type: "object", additionalProperties: true },
            minItems: 1,
          },
        },
        required: ["page_id", "children"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as { page_id?: string; children?: unknown[] };
      if (!args.page_id || !args.children?.length) {
        return {
          content: "notion.append_blocks: page_id and a non-empty children array are required",
          isError: true,
        };
      }
      if (!secrets) return { content: "notion.append_blocks: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("notion");
      try {
        await notionFetch({
          accessToken: conn.accessToken,
          path: `/blocks/${args.page_id}/children`,
          method: "PATCH",
          body: { children: args.children },
        });
        return { content: `notion.append_blocks: appended ${args.children.length} block(s)` };
      } catch (err) {
        return handleNotionError("notion.append_blocks", err);
      }
    },
  };
}

function updatePageProperties(): LocalToolHandler {
  return {
    definition: {
      name: "update_page_properties",
      description:
        "Update properties on an existing Notion page (typically a database row). Pass only the properties you want to change; others are left untouched.",
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
          archived: {
            type: "boolean",
            description: "Set to true to archive the page, false to un-archive.",
          },
        },
        required: ["page_id"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        page_id?: string;
        properties?: Record<string, unknown>;
        archived?: boolean;
      };
      if (!args.page_id) {
        return { content: "notion.update_page_properties: page_id is required", isError: true };
      }
      if (!args.properties && typeof args.archived !== "boolean") {
        return {
          content: "notion.update_page_properties: pass at least one of properties or archived",
          isError: true,
        };
      }
      if (!secrets)
        return { content: "notion.update_page_properties: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("notion");
      try {
        const body: Record<string, unknown> = {};
        if (args.properties) body.properties = args.properties;
        if (typeof args.archived === "boolean") body.archived = args.archived;
        await notionFetch({
          accessToken: conn.accessToken,
          path: `/pages/${args.page_id}`,
          method: "PATCH",
          body,
        });
        return { content: `notion.update_page_properties: updated id=${args.page_id}` };
      } catch (err) {
        return handleNotionError("notion.update_page_properties", err);
      }
    },
  };
}
