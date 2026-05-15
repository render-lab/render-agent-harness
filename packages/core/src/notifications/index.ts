import type { Logger } from "../logger.js";
import { getSchedule, loadLastAssistantText, recordNotificationDelivery } from "../state/repo.js";
import type { NotificationConfig, RunId, ScheduleId, UserId } from "../types.js";

export interface DispatchScheduledNotificationsArgs {
  pool: import("pg").Pool;
  runId: RunId;
  scheduleId: ScheduleId;
  userId: UserId;
  operatorUrl?: string | null;
  logger: Logger;
}

export async function dispatchScheduledNotifications(
  args: DispatchScheduledNotificationsArgs,
): Promise<void> {
  const schedule = await getSchedule(args.pool, { id: args.scheduleId, userId: args.userId });
  if (!schedule) {
    args.logger.warn(
      { scheduleId: args.scheduleId },
      "scheduled notification skipped; schedule missing",
    );
    return;
  }
  const summary = (await loadLastAssistantText(args.pool, args.runId)) ?? "(no assistant output)";
  for (const notification of schedule.notifications) {
    await deliverOne({
      ...args,
      notification,
      summary,
    });
  }
}

async function deliverOne(args: {
  pool: import("pg").Pool;
  runId: RunId;
  scheduleId: ScheduleId;
  userId: UserId;
  notification: NotificationConfig;
  summary: string;
  operatorUrl?: string | null;
  logger: Logger;
}): Promise<void> {
  try {
    if (args.notification.kind === "slack") {
      await postJson(args.notification.target, { text: args.summary });
    } else if (args.notification.kind === "webhook") {
      await postJson(args.notification.target, {
        scheduleId: args.scheduleId,
        runId: args.runId,
        summary: args.summary,
        operatorUrl: args.operatorUrl ?? null,
        finishedAt: new Date().toISOString(),
      });
    }
    await recordNotificationDelivery(args.pool, {
      runId: args.runId,
      scheduleId: args.scheduleId,
      userId: args.userId,
      kind: args.notification.kind,
      target: args.notification.target,
      summary: args.summary,
      status: "delivered",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    args.logger.warn(
      { scheduleId: args.scheduleId, kind: args.notification.kind, err: message },
      "scheduled notification delivery failed",
    );
    await recordNotificationDelivery(args.pool, {
      runId: args.runId,
      scheduleId: args.scheduleId,
      userId: args.userId,
      kind: args.notification.kind,
      target: args.notification.target,
      summary: args.summary,
      status: "failed",
      error: message,
    });
  }
}

async function postJson(target: string | null, payload: unknown): Promise<void> {
  if (!target) throw new Error("notification target is required");
  const res = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
}
