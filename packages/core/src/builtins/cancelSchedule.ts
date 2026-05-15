import { deleteSchedule, setScheduleEnabled } from "../state/repo.js";
import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

export const cancelScheduleFactory: BuiltinFactory = (ctx) => ({
  registered: true,
  handler: buildHandler(ctx),
});

interface Input {
  scheduleId?: string;
  hard?: boolean;
}

function buildHandler(ctx: { pool: import("pg").Pool; userId: string | null }): LocalToolHandler {
  return {
    definition: {
      name: "cancel_schedule",
      description: "Cancel one of your recurring scheduled runs. Defaults to a soft cancel.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scheduleId: { type: "string", minLength: 1 },
          hard: {
            type: "boolean",
            description: "When true, delete the schedule row. Default false disables it.",
          },
        },
        required: ["scheduleId"],
      },
    },
    handler: async ({ input }) => {
      if (ctx.userId == null) {
        return {
          content: "cancel_schedule: no authenticated user attached to this run",
          isError: true,
        };
      }
      const args = (input ?? {}) as Input;
      const scheduleId = args.scheduleId?.trim();
      if (!scheduleId) return { content: "cancel_schedule: missing scheduleId", isError: true };
      if (args.hard === true) {
        await deleteSchedule(ctx.pool, { id: scheduleId, userId: ctx.userId });
        return { content: `deleted schedule ${scheduleId}` };
      }
      await setScheduleEnabled(ctx.pool, { id: scheduleId, userId: ctx.userId, enabled: false });
      return { content: `disabled schedule ${scheduleId}` };
    },
  };
}
