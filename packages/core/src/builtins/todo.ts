import { mergeRunMetadata } from "../state/repo.js";
import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `todo` — per-run task list. Stored under `agent_runs.metadata.todos`.
 *
 * Two operations on one tool:
 *   - `action: "list"` → return the current list (defaults if no `todos` arg).
 *   - `action: "write"` (or omitted when `todos` is provided) → upsert
 *     items by id; when `merge: true` (default) keep existing items not
 *     mentioned in the call, otherwise replace the list wholesale.
 *
 * Statuses are `pending | in_progress | completed | cancelled` to match
 * the operator UI's conventions (and Cursor's own todo tool for that
 * matter).
 */
export const todoFactory: BuiltinFactory = (ctx) => ({
  registered: true,
  handler: buildHandler(ctx),
});

const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

interface TodoInput {
  action?: "list" | "write";
  todos?: Array<Partial<TodoItem>>;
  merge?: boolean;
}

function buildHandler(ctx: { pool: import("pg").Pool; runId: string }): LocalToolHandler {
  // In-memory cache so repeated reads inside a single run don't keep hitting
  // Postgres. Writes still go through to the DB so the operator UI can see
  // the list update in real time.
  let cached: TodoItem[] | null = null;

  return {
    definition: {
      name: "todo",
      description:
        "Per-run task list. Use for multi-step work (3+ steps) so progress stays visible to the operator. Call with no arguments to read the list, or pass `todos` to create/update items by id. Status values: pending, in_progress, completed, cancelled.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["list", "write"], description: "Defaults to 'list' if no `todos` provided, 'write' otherwise." },
          merge: {
            type: "boolean",
            description:
              "When writing, true (default) merges by id; false replaces the entire list.",
          },
          todos: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", description: "Stable identifier; reuse to update." },
                content: { type: "string", description: "What needs to be done." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
              },
              required: ["id", "content", "status"],
            },
            description: "Items to upsert (or replace, when merge=false).",
          },
        },
      },
    },
    handler: async ({ input }) => {
      const args = (input ?? {}) as TodoInput;
      const action = args.action ?? (args.todos ? "write" : "list");

      if (action === "list") {
        const list = cached ?? (await readFromDb(ctx));
        cached = list;
        return { content: renderList(list) };
      }

      if (!Array.isArray(args.todos)) {
        return { content: "todo: write requires `todos` array", isError: true };
      }

      const incoming: TodoItem[] = [];
      for (const raw of args.todos) {
        if (!raw || typeof raw !== "object") {
          return { content: "todo: each item must be an object", isError: true };
        }
        if (typeof raw.id !== "string" || raw.id.length === 0) {
          return { content: "todo: each item needs a non-empty `id`", isError: true };
        }
        if (typeof raw.content !== "string" || raw.content.length === 0) {
          return { content: `todo: item ${raw.id} needs a non-empty \`content\``, isError: true };
        }
        if (!raw.status || !STATUSES.has(raw.status)) {
          return {
            content: `todo: item ${raw.id} has invalid status "${raw.status}" (use pending|in_progress|completed|cancelled)`,
            isError: true,
          };
        }
        incoming.push({ id: raw.id, content: raw.content, status: raw.status as TodoItem["status"] });
      }

      const merge = args.merge ?? true;
      const existing = cached ?? (await readFromDb(ctx));
      const next = merge ? mergeById(existing, incoming) : incoming;
      cached = next;
      await mergeRunMetadata(ctx.pool, ctx.runId, { todos: next });
      return { content: renderList(next) };
    },
  };
}

function mergeById(existing: TodoItem[], incoming: TodoItem[]): TodoItem[] {
  const byId = new Map(existing.map((t) => [t.id, t] as const));
  for (const t of incoming) byId.set(t.id, t);
  return [...byId.values()];
}

async function readFromDb(ctx: { pool: import("pg").Pool; runId: string }): Promise<TodoItem[]> {
  const { rows } = await ctx.pool.query<{ todos: unknown }>(
    "SELECT metadata->'todos' AS todos FROM agent_runs WHERE id = $1",
    [ctx.runId],
  );
  const raw = rows[0]?.todos;
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { content?: unknown }).content === "string" &&
      typeof (item as { status?: unknown }).status === "string" &&
      STATUSES.has((item as { status: string }).status)
    ) {
      out.push(item as TodoItem);
    }
  }
  return out;
}

function renderList(list: TodoItem[]): string {
  if (list.length === 0) return "(no todos yet)";
  const symbol = (s: TodoItem["status"]): string => {
    switch (s) {
      case "completed":
        return "[x]";
      case "in_progress":
        return "[~]";
      case "cancelled":
        return "[-]";
      default:
        return "[ ]";
    }
  };
  return list.map((t) => `${symbol(t.status)} ${t.id}: ${t.content}`).join("\n");
}
