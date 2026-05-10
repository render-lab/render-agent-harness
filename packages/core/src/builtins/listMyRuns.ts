import { listRuns } from "../state/repo.js";
import type { LocalToolHandler, RunStatus } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `list_my_runs({ status?, agent?, limit? })` — read-only view of the
 * caller's recent runs.
 *
 * Hard-scoped to `ctx.userId`. If the userId is null (e.g. cron job, no
 * auth) the tool registers but returns an empty list — leaking another
 * tenant's runs by accident is the failure mode we're protecting against.
 *
 * `agent` defaults to the current agent name; pass `agent: "*"` to span
 * every agent the caller has used.
 */
export const listMyRunsFactory: BuiltinFactory = (ctx) => ({
  registered: true,
  handler: buildHandler(ctx),
});

const VALID_STATUSES: ReadonlySet<RunStatus> = new Set([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

interface Input {
  status?: RunStatus | RunStatus[];
  agent?: string;
  limit?: number;
}

function buildHandler(ctx: {
  pool: import("pg").Pool;
  userId: string | null;
  agentName: string;
}): LocalToolHandler {
  return {
    definition: {
      name: "list_my_runs",
      description:
        "List your recent agent runs (newest first). Defaults to runs of the current agent for the calling user. Use to answer 'what have I been doing?', 'what runs failed?', etc.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            description:
              "Filter by status (one or many). Values: pending, running, paused, completed, failed, cancelled.",
            oneOf: [
              {
                type: "string",
                enum: ["pending", "running", "paused", "completed", "failed", "cancelled"],
              },
              {
                type: "array",
                items: {
                  type: "string",
                  enum: ["pending", "running", "paused", "completed", "failed", "cancelled"],
                },
                minItems: 1,
              },
            ],
          },
          agent: {
            type: "string",
            description:
              "Restrict to one agent name. Defaults to the current agent. Pass '*' to span every agent.",
          },
          limit: {
            type: "integer",
            description: "Max rows. Defaults to 20, capped at 50.",
            minimum: 1,
            maximum: 50,
          },
        },
      },
    },
    handler: async ({ input }) => {
      if (ctx.userId == null) {
        return { content: "(no runs visible: no authenticated user attached to this run)" };
      }
      const args = (input ?? {}) as Input;
      const limit = clamp(args.limit, 20, 1, 50);
      const agent = args.agent === "*" ? undefined : args.agent ?? ctx.agentName;
      const statuses = normalizeStatuses(args.status);

      const page = await listRuns(ctx.pool, {
        userId: ctx.userId,
        ...(agent ? { agentName: agent } : {}),
        ...(statuses.length > 0 ? { status: statuses } : {}),
        limit,
      });

      if (page.runs.length === 0) {
        return { content: "(no matching runs)" };
      }
      const lines = page.runs.map((r) => {
        const started = r.startedAt?.toISOString() ?? "—";
        const finished = r.finishedAt?.toISOString() ?? "—";
        const cost = r.totalCostUsd > 0 ? `$${r.totalCostUsd.toFixed(4)}` : "$0";
        return [
          `id=${r.id}`,
          `agent=${r.agentName}@${r.agentVersion}`,
          `status=${r.status}`,
          `started=${started}`,
          `finished=${finished}`,
          `cost=${cost}`,
          `turns=${r.cursor.turn}`,
          `tools=${r.cursor.toolCalls}`,
        ].join(" ");
      });
      return { content: lines.join("\n") };
    },
  };
}

function clamp(raw: number | undefined, def: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return def;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function normalizeStatuses(raw: RunStatus | RunStatus[] | undefined): RunStatus[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((s): s is RunStatus => typeof s === "string" && VALID_STATUSES.has(s));
}
