import { CronExpressionParser } from "cron-parser";
import type { NotificationConfig } from "./types.js";

const NOTIFICATION_KINDS = new Set(["slack", "webhook", "inbox"]);

export function normalizeCron(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cron = raw.trim();
  if (!cron) return null;
  try {
    CronExpressionParser.parse(cron);
    return cron;
  } catch {
    return null;
  }
}

export function nextCronFire(cron: string, timezone: string): Date {
  const expr = CronExpressionParser.parse(cron, {
    currentDate: new Date(),
    tz: timezone,
  });
  return expr.next().toDate();
}

export function normalizeTimezone(raw: unknown): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : "UTC";
}

export function normalizeNotifications(raw: unknown): NotificationConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.kind !== "string" || !NOTIFICATION_KINDS.has(rec.kind)) continue;
    const target = typeof rec.target === "string" && rec.target.trim() ? rec.target.trim() : null;
    if ((rec.kind === "slack" || rec.kind === "webhook") && !target) continue;
    out.push({ kind: rec.kind as NotificationConfig["kind"], target });
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
