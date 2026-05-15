import {
  isRecord,
  nextCronFire,
  normalizeCron,
  normalizeNotifications,
  normalizeTimezone,
} from "../schedules.js";
import { getSchedule, updateSchedule } from "../state/repo.js";
import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

export const updateScheduleFactory: BuiltinFactory = (ctx) => ({
  registered: true,
  handler: buildHandler(ctx),
});

interface Input {
  scheduleId?: string;
  patch?: {
    input?: string;
    cron?: string;
    timezone?: string;
    notifications?: unknown[];
    enabled?: boolean;
    metadata?: Record<string, unknown>;
  };
}

function buildHandler(ctx: { pool: import("pg").Pool; userId: string | null }): LocalToolHandler {
  return {
    definition: {
      name: "update_schedule",
      description:
        "Update one of your recurring scheduled agent runs. Use for changing the cron, prompt, notifications, metadata, or enabled state.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scheduleId: { type: "string", minLength: 1 },
          patch: {
            type: "object",
            additionalProperties: false,
            properties: {
              input: { type: "string" },
              cron: { type: "string" },
              timezone: { type: "string" },
              notifications: { type: "array", items: { type: "object" } },
              enabled: { type: "boolean" },
              metadata: { type: "object", additionalProperties: true },
            },
          },
        },
        required: ["scheduleId", "patch"],
      },
    },
    handler: async ({ input }) => {
      if (ctx.userId == null) {
        return {
          content: "update_schedule: no authenticated user attached to this run",
          isError: true,
        };
      }
      const args = (input ?? {}) as Input;
      const scheduleId = args.scheduleId?.trim();
      if (!scheduleId) return { content: "update_schedule: missing scheduleId", isError: true };
      const existing = await getSchedule(ctx.pool, { id: scheduleId, userId: ctx.userId });
      if (!existing) return { content: "update_schedule: schedule not found", isError: true };

      const patch = args.patch ?? {};
      const cron = patch.cron !== undefined ? normalizeCron(patch.cron) : existing.cronExpr;
      if (!cron) return { content: "update_schedule: invalid cron expression", isError: true };
      const timezone =
        patch.timezone !== undefined ? normalizeTimezone(patch.timezone) : existing.timezone;
      let nextFireAt: Date | undefined;
      if (patch.cron !== undefined || patch.timezone !== undefined) {
        try {
          nextFireAt = nextCronFire(cron, timezone);
        } catch (err) {
          return {
            content: `update_schedule: invalid cron/timezone (${err instanceof Error ? err.message : String(err)})`,
            isError: true,
          };
        }
      }

      const updated = await updateSchedule(ctx.pool, {
        id: scheduleId,
        userId: ctx.userId,
        patch: {
          ...(patch.input !== undefined ? { input: patch.input } : {}),
          ...(patch.cron !== undefined ? { cronExpr: cron } : {}),
          ...(patch.timezone !== undefined ? { timezone } : {}),
          ...(patch.notifications !== undefined
            ? { notifications: normalizeNotifications(patch.notifications) }
            : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(isRecord(patch.metadata) ? { metadata: patch.metadata } : {}),
          ...(nextFireAt ? { nextFireAt } : {}),
        },
      });
      return {
        content: JSON.stringify(
          {
            scheduleId: updated.id,
            enabled: updated.enabled,
            cron: updated.cronExpr,
            timezone: updated.timezone,
            nextFireAt: updated.nextFireAt?.toISOString() ?? null,
          },
          null,
          2,
        ),
      };
    },
  };
}
