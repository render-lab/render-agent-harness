import type { LocalToolHandler } from "@render-harness/core";
import { figmaFetch, formatFigmaError } from "./lib.js";
import type { FigmaAccessMode } from "./oauth.js";

export function figmaTools(args: { accessMode: FigmaAccessMode }): LocalToolHandler[] {
  const tools: LocalToolHandler[] = [
    readFile(),
    readFileNodes(),
    readFileMetadata(),
    listTeamProjects(),
    listProjectFiles(),
    readComments(),
  ];
  if (args.accessMode === "read_write_comments") {
    tools.push(postComment());
  }
  return tools;
}

// --------------------------------------------------------------------
// File reads
// --------------------------------------------------------------------

function readFile(): LocalToolHandler {
  return {
    definition: {
      name: "read_file",
      description:
        "Read a Figma file's document tree. By default returns the page-and-frame structure to depth 2 (pages → top-level frames), which is enough for navigation and naming. Pass `depth: N` for deeper, OR `ids: [...]` to fetch specific nodes only (preferred for big files; depth=2 is the v1 default to avoid token blowups). Use read_file_nodes when you already have node ids and just want their full content.",
      source: "pack:cap-figma",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_key: {
            type: "string",
            description: "Figma file key (the alphanumeric segment in the file URL).",
            minLength: 1,
          },
          depth: {
            type: "integer",
            description: "Tree depth. Default 2; raise carefully — files can be huge.",
            minimum: 1,
            maximum: 8,
          },
          ids: {
            type: "array",
            description:
              "Optional list of node ids to scope the read to (comma-joined into the API's `ids` query param).",
            items: { type: "string" },
          },
        },
        required: ["file_key"],
      },
    },
    async handler({ input, secrets, signal }) {
      const args = (input ?? {}) as { file_key?: string; depth?: number; ids?: string[] };
      if (!args.file_key) {
        return { content: "figma.read_file: file_key is required", isError: true };
      }
      if (!secrets) {
        return { content: "figma.read_file: no SecretsContext on this run", isError: true };
      }
      const conn = await secrets.requireConnection("figma");
      try {
        const query: Record<string, string | number> = { depth: args.depth ?? 2 };
        if (args.ids && args.ids.length > 0) query.ids = args.ids.join(",");
        const res = await figmaFetch({
          accessToken: conn.accessToken,
          path: `/files/${encodeURIComponent(args.file_key)}`,
          query,
          ...(signal ? { signal } : {}),
        });
        return { content: JSON.stringify(res, null, 2) };
      } catch (err) {
        return formatFigmaError("figma.read_file", "read file content", err);
      }
    },
  };
}

function readFileNodes(): LocalToolHandler {
  return {
    definition: {
      name: "read_file_nodes",
      description:
        "Fetch one or more nodes from a Figma file by id. Returns the full node tree for each (children included). Use this when read_file returned an outline and you want the full content of specific nodes (e.g. one frame, one component).",
      source: "pack:cap-figma",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_key: { type: "string", minLength: 1 },
          ids: {
            type: "array",
            description: "Node ids to fetch (max 200 per call per Figma docs).",
            items: { type: "string", minLength: 1 },
            minItems: 1,
          },
          depth: {
            type: "integer",
            description: "Per-node depth. Defaults to entire subtree.",
            minimum: 1,
            maximum: 8,
          },
        },
        required: ["file_key", "ids"],
      },
    },
    async handler({ input, secrets, signal }) {
      const args = (input ?? {}) as { file_key?: string; ids?: string[]; depth?: number };
      if (!args.file_key || !args.ids?.length) {
        return {
          content: "figma.read_file_nodes: file_key and a non-empty ids array are required",
          isError: true,
        };
      }
      if (!secrets) {
        return { content: "figma.read_file_nodes: no SecretsContext", isError: true };
      }
      const conn = await secrets.requireConnection("figma");
      try {
        const query: Record<string, string | number> = { ids: args.ids.join(",") };
        if (args.depth) query.depth = args.depth;
        const res = await figmaFetch({
          accessToken: conn.accessToken,
          path: `/files/${encodeURIComponent(args.file_key)}/nodes`,
          query,
          ...(signal ? { signal } : {}),
        });
        return { content: JSON.stringify(res, null, 2) };
      } catch (err) {
        return formatFigmaError("figma.read_file_nodes", "read file content", err);
      }
    },
  };
}

function readFileMetadata(): LocalToolHandler {
  return {
    definition: {
      name: "read_file_metadata",
      description:
        "Read a Figma file's metadata: name, last_modified, role, thumbnail_url, version. Cheap and doesn't pull the document tree — useful as a first call to confirm the file_key is right before fetching content.",
      source: "pack:cap-figma",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_key: { type: "string", minLength: 1 },
        },
        required: ["file_key"],
      },
    },
    async handler({ input, secrets, signal }) {
      const args = (input ?? {}) as { file_key?: string };
      if (!args.file_key) {
        return { content: "figma.read_file_metadata: file_key is required", isError: true };
      }
      if (!secrets) {
        return { content: "figma.read_file_metadata: no SecretsContext", isError: true };
      }
      const conn = await secrets.requireConnection("figma");
      try {
        const res = await figmaFetch({
          accessToken: conn.accessToken,
          path: `/files/${encodeURIComponent(args.file_key)}/meta`,
          ...(signal ? { signal } : {}),
        });
        return { content: JSON.stringify(res, null, 2) };
      } catch (err) {
        return formatFigmaError("figma.read_file_metadata", "read file metadata", err);
      }
    },
  };
}

// --------------------------------------------------------------------
// Projects / teams
// --------------------------------------------------------------------

function listTeamProjects(): LocalToolHandler {
  return {
    definition: {
      name: "list_team_projects",
      description:
        "List projects in a Figma team. The team_id is in the team URL (`https://www.figma.com/files/team/<team_id>/...`). Returns id and name per project; use list_project_files to drill into one.",
      source: "pack:cap-figma",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          team_id: { type: "string", minLength: 1 },
        },
        required: ["team_id"],
      },
    },
    async handler({ input, secrets, signal }) {
      const args = (input ?? {}) as { team_id?: string };
      if (!args.team_id) {
        return { content: "figma.list_team_projects: team_id is required", isError: true };
      }
      if (!secrets) {
        return { content: "figma.list_team_projects: no SecretsContext", isError: true };
      }
      const conn = await secrets.requireConnection("figma");
      try {
        const res = await figmaFetch<{ projects?: Array<{ id?: string; name?: string }> }>({
          accessToken: conn.accessToken,
          path: `/teams/${encodeURIComponent(args.team_id)}/projects`,
          ...(signal ? { signal } : {}),
        });
        const projects = res.projects ?? [];
        if (projects.length === 0) {
          return { content: "figma.list_team_projects: no projects in this team" };
        }
        const lines = projects.map(
          (p, i) => `${i + 1}. id=${p.id ?? "?"}  ${p.name ?? "(unnamed)"}`,
        );
        return { content: lines.join("\n") };
      } catch (err) {
        return formatFigmaError("figma.list_team_projects", "list team projects", err);
      }
    },
  };
}

function listProjectFiles(): LocalToolHandler {
  return {
    definition: {
      name: "list_project_files",
      description:
        "List Figma files in a project. Returns key, name, thumbnail_url, last_modified per file.",
      source: "pack:cap-figma",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          project_id: { type: "string", minLength: 1 },
        },
        required: ["project_id"],
      },
    },
    async handler({ input, secrets, signal }) {
      const args = (input ?? {}) as { project_id?: string };
      if (!args.project_id) {
        return { content: "figma.list_project_files: project_id is required", isError: true };
      }
      if (!secrets) {
        return { content: "figma.list_project_files: no SecretsContext", isError: true };
      }
      const conn = await secrets.requireConnection("figma");
      try {
        const res = await figmaFetch<{
          files?: Array<{
            key?: string;
            name?: string;
            thumbnail_url?: string;
            last_modified?: string;
          }>;
        }>({
          accessToken: conn.accessToken,
          path: `/projects/${encodeURIComponent(args.project_id)}/files`,
          ...(signal ? { signal } : {}),
        });
        const files = res.files ?? [];
        if (files.length === 0) {
          return { content: "figma.list_project_files: no files in this project" };
        }
        const lines = files.map(
          (f, i) =>
            `${i + 1}. key=${f.key ?? "?"}  ${f.name ?? "(unnamed)"}\n   last_modified=${f.last_modified ?? "?"}`,
        );
        return { content: lines.join("\n\n") };
      } catch (err) {
        return formatFigmaError("figma.list_project_files", "list project files", err);
      }
    },
  };
}

// --------------------------------------------------------------------
// Comments
// --------------------------------------------------------------------

function readComments(): LocalToolHandler {
  return {
    definition: {
      name: "read_comments",
      description:
        "List comments on a Figma file. Returns id, user, message, created_at, resolved_at, parent_id (for replies). Use post_comment to reply or pin a new comment.",
      source: "pack:cap-figma",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_key: { type: "string", minLength: 1 },
          as_md: {
            type: "boolean",
            description: "Render comments as a markdown-style thread instead of raw JSON.",
          },
        },
        required: ["file_key"],
      },
    },
    async handler({ input, secrets, signal }) {
      const args = (input ?? {}) as { file_key?: string; as_md?: boolean };
      if (!args.file_key) {
        return { content: "figma.read_comments: file_key is required", isError: true };
      }
      if (!secrets) {
        return { content: "figma.read_comments: no SecretsContext", isError: true };
      }
      const conn = await secrets.requireConnection("figma");
      try {
        const res = await figmaFetch<{
          comments?: Array<{
            id?: string;
            user?: { handle?: string; email?: string };
            message?: string;
            created_at?: string;
            resolved_at?: string | null;
            parent_id?: string | null;
          }>;
        }>({
          accessToken: conn.accessToken,
          path: `/files/${encodeURIComponent(args.file_key)}/comments`,
          ...(signal ? { signal } : {}),
        });
        const comments = res.comments ?? [];
        if (comments.length === 0) {
          return { content: "figma.read_comments: no comments on this file" };
        }
        if (!args.as_md) {
          return { content: JSON.stringify(res, null, 2) };
        }
        const lines = comments.map((c) => {
          const who = c.user?.handle ?? c.user?.email ?? "?";
          const when = c.created_at ?? "?";
          const tag = c.resolved_at
            ? "(resolved)"
            : c.parent_id
              ? `(reply to ${c.parent_id})`
              : "(top-level)";
          return `- [${when}] ${who} ${tag}\n  id=${c.id}\n  ${c.message?.replace(/\n/g, "\n  ") ?? ""}`;
        });
        return { content: lines.join("\n\n") };
      } catch (err) {
        return formatFigmaError("figma.read_comments", "read comments", err);
      }
    },
  };
}

function postComment(): LocalToolHandler {
  return {
    definition: {
      name: "post_comment",
      description:
        "Post a comment on a Figma file. To reply to an existing comment, pass `comment_id` (the id of the parent). To pin at specific coordinates, pass `client_meta` with `{ x, y }` and optional `node_id`/`node_offset`. Returns the new comment id.",
      source: "pack:cap-figma",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_key: { type: "string", minLength: 1 },
          message: { type: "string", description: "Comment body.", minLength: 1 },
          comment_id: {
            type: "string",
            description: "Parent comment id when replying to an existing thread.",
          },
          client_meta: {
            type: "object",
            description:
              "Optional pin location: { x, y } for free-floating, OR { node_id, node_offset: { x, y } } for a pin attached to a node.",
            additionalProperties: true,
          },
        },
        required: ["file_key", "message"],
      },
    },
    async handler({ input, secrets, signal }) {
      const args = (input ?? {}) as {
        file_key?: string;
        message?: string;
        comment_id?: string;
        client_meta?: Record<string, unknown>;
      };
      if (!args.file_key || !args.message) {
        return {
          content: "figma.post_comment: file_key and message are required",
          isError: true,
        };
      }
      if (!secrets) return { content: "figma.post_comment: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("figma");
      try {
        const body: Record<string, unknown> = { message: args.message };
        if (args.comment_id) body.comment_id = args.comment_id;
        if (args.client_meta) body.client_meta = args.client_meta;
        const res = await figmaFetch<{ id?: string }>({
          accessToken: conn.accessToken,
          path: `/files/${encodeURIComponent(args.file_key)}/comments`,
          method: "POST",
          body,
          ...(signal ? { signal } : {}),
        });
        return {
          content: `figma.post_comment: posted comment id=${res.id ?? "?"} on file ${args.file_key}`,
        };
      } catch (err) {
        return formatFigmaError("figma.post_comment", "post comment", err);
      }
    },
  };
}
