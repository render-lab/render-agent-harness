import { listSchedules } from "../state/repo.js";
import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

export const listSchedulesFactory: BuiltinFactory = (ctx) => ({
  registered: true,
  handler: buildHandler(ctx),
});

interface Input {
  enabledOnly?: boolean;
}

function buildHandler(ctx: { pool: import("pg").Pool; userId: string | null }): LocalToolHandler {
  return {
    definition: {
      name: "list_schedules",
      description: "List your recurring scheduled agent runs.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabledOnly: {
            type: "boolean",
            description: "When true, only return schedules that are currently enabled.",
          },
        },
      },
    },
    handler: async ({ input }) => {
      if (ctx.userId == null) {
        return { content: "(no schedules visible: no authenticated user attached to this run)" };
      }
      const args = (input ?? {}) as Input;
      const schedules = await listSchedules(ctx.pool, {
        userId: ctx.userId,
        ...(args.enabledOnly ? { enabled: true } : {}),
      });
      if (schedules.length === 0) return { content: "(no schedules)" };
      return {
        content: schedules
          .map((s) =>
            [
              `id=${s.id}`,
              `agent=${s.agentName}`,
              `enabled=${s.enabled}`,
              `cron="${s.cronExpr}"`,
              `timezone=${s.timezone}`,
              `next=${s.nextFireAt?.toISOString() ?? "—"}`,
              `last=${s.lastFiredAt?.toISOString() ?? "—"}`,
              `notifications=${s.notifications.map((n) => n.kind).join(",") || "none"}`,
            ].join(" "),
          )
          .join("\n"),
      };
    },
  };
}
