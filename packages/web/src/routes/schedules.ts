import {
  listInboxItems,
  listScheduleRuns,
  listSchedules,
  type Pool,
  type UserId,
} from "@render-harness/core";
import type { Hono } from "hono";
import { serializeInboxItem, serializeRun, serializeSchedule } from "../serializers.js";

export interface ScheduleRouteContext {
  pool: Pool;
  auth: (req: Request) => Promise<UserId | null>;
  pathPrefix: string;
}

export function registerScheduleRoutes(app: Hono, ctx: ScheduleRouteContext): void {
  const { pool, auth, pathPrefix } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;

  app.get(r("/schedules"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const enabledParam = c.req.query("enabled");
    const schedules = await listSchedules(pool, {
      userId,
      ...(enabledParam === "true" ? { enabled: true } : {}),
      ...(enabledParam === "false" ? { enabled: false } : {}),
    });
    return c.json({ schedules: schedules.map(serializeSchedule) });
  });

  app.get(r("/schedules/:id/runs"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing_id" }, 400);
    const limit = clampLimit(c.req.query("limit"));
    const rows = await listScheduleRuns(pool, { scheduleId: id, userId, limit });
    return c.json({
      runs: rows.map(({ scheduleRun, run, summary }) => ({
        scheduleId: scheduleRun.scheduleId,
        run: serializeRun(run),
        firedAt: scheduleRun.firedAt.toISOString(),
        summary,
      })),
    });
  });

  app.get(r("/inbox"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const items = await listInboxItems(pool, { userId, limit: clampLimit(c.req.query("limit")) });
    return c.json({ items: items.map(serializeInboxItem) });
  });
}

function clampLimit(raw: string | undefined): number {
  const n = raw ? Number(raw) : 50;
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(100, Math.floor(n)));
}
