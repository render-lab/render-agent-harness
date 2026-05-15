import { listInboxItems, listScheduleRuns } from "../state/repo.js";
import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

export const listScheduledOutputsFactory: BuiltinFactory = (ctx) => ({
  registered: true,
  handler: buildHandler(ctx),
});

interface Input {
  scheduleId?: string;
  limit?: number;
}

function buildHandler(ctx: { pool: import("pg").Pool; userId: string | null }): LocalToolHandler {
  return {
    definition: {
      name: "list_scheduled_outputs",
      description:
        "List recent outputs from your scheduled runs. With scheduleId, returns that schedule's run history; otherwise returns your scheduled-run inbox.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scheduleId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
    handler: async ({ input }) => {
      if (ctx.userId == null) {
        return {
          content: "(no scheduled outputs visible: no authenticated user attached to this run)",
        };
      }
      const args = (input ?? {}) as Input;
      const limit = clamp(args.limit, 20, 1, 50);
      const scheduleId = args.scheduleId?.trim();
      if (scheduleId) {
        const runs = await listScheduleRuns(ctx.pool, { scheduleId, userId: ctx.userId, limit });
        if (runs.length === 0) return { content: "(no runs for that schedule)" };
        return {
          content: runs
            .map(({ run, scheduleRun, summary }) =>
              [
                `schedule=${scheduleRun.scheduleId}`,
                `run=${run.id}`,
                `agent=${run.agentName}`,
                `status=${run.status}`,
                `fired=${scheduleRun.firedAt.toISOString()}`,
                `summary=${summary ?? "(no assistant output yet)"}`,
              ].join(" "),
            )
            .join("\n"),
        };
      }

      const items = await listInboxItems(ctx.pool, { userId: ctx.userId, limit });
      if (items.length === 0) return { content: "(scheduled-run inbox is empty)" };
      return {
        content: items
          .map((item) =>
            [
              `id=${item.id}`,
              `schedule=${item.scheduleId ?? "—"}`,
              `run=${item.runId}`,
              `status=${item.status}`,
              `created=${item.createdAt.toISOString()}`,
              `summary=${item.summary}`,
            ].join(" "),
          )
          .join("\n"),
      };
    },
  };
}

function clamp(raw: number | undefined, def: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return def;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}
