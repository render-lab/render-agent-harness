import {
  isRecord,
  nextCronFire,
  normalizeCron,
  normalizeNotifications,
  normalizeTimezone,
} from "../schedules.js";
import { createSchedule } from "../state/repo.js";
import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

export const scheduleRunFactory: BuiltinFactory = (ctx) => ({
  registered: true,
  handler: buildHandler(ctx),
});

interface Input {
  agentName?: string;
  input?: string;
  cron?: string;
  timezone?: string;
  notifications?: unknown[];
  metadata?: Record<string, unknown>;
}

function buildHandler(ctx: {
  pool: import("pg").Pool;
  userId: string | null;
  agentName: string;
}): LocalToolHandler {
  return {
    definition: {
      name: "schedule_run",
      description:
        "Create a recurring agent run for the authenticated user. Use when the user asks to run an agent on a schedule and optionally deliver results to Slack, a webhook, or the UI inbox.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          agentName: {
            type: "string",
            description: "Agent to run on each tick. Defaults to the current agent.",
          },
          input: {
            type: "string",
            description: "Prompt sent to the scheduled agent on every tick.",
            minLength: 1,
          },
          cron: {
            type: "string",
            description: "Five-field cron expression, for example '0 9 * * 1-5'.",
            minLength: 1,
          },
          timezone: {
            type: "string",
            description: "IANA timezone for the cron schedule. Defaults to UTC.",
          },
          notifications: {
            type: "array",
            description:
              "Delivery targets: {kind:'inbox',target:null}, {kind:'slack',target:'https://hooks.slack.com/...'}, or {kind:'webhook',target:'https://...'}",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["slack", "webhook", "inbox"] },
                target: { type: ["string", "null"] },
              },
              required: ["kind"],
            },
          },
          metadata: { type: "object", additionalProperties: true },
        },
        required: ["input", "cron"],
      },
    },
    handler: async ({ input }) => {
      if (ctx.userId == null) {
        return {
          content: "schedule_run: no authenticated user attached to this run",
          isError: true,
        };
      }
      const args = (input ?? {}) as Input;
      const prompt = typeof args.input === "string" ? args.input.trim() : "";
      if (!prompt)
        return { content: "schedule_run: input must be a non-empty string", isError: true };
      const cron = normalizeCron(args.cron);
      if (!cron) return { content: "schedule_run: invalid cron expression", isError: true };
      const timezone = normalizeTimezone(args.timezone);
      let nextFireAt: Date;
      try {
        nextFireAt = nextCronFire(cron, timezone);
      } catch (err) {
        return {
          content: `schedule_run: invalid cron/timezone (${err instanceof Error ? err.message : String(err)})`,
          isError: true,
        };
      }
      const schedule = await createSchedule(ctx.pool, {
        userId: ctx.userId,
        agentName: args.agentName?.trim() || ctx.agentName,
        input: prompt,
        cronExpr: cron,
        timezone,
        notifications: normalizeNotifications(args.notifications),
        metadata: isRecord(args.metadata) ? args.metadata : {},
        nextFireAt,
      });
      return {
        content: JSON.stringify(
          {
            scheduleId: schedule.id,
            agentName: schedule.agentName,
            cron: schedule.cronExpr,
            timezone: schedule.timezone,
            nextFireAt: schedule.nextFireAt?.toISOString() ?? null,
            notifications: schedule.notifications,
          },
          null,
          2,
        ),
      };
    },
  };
}
