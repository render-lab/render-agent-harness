import { aggregateUsage, type Pool, type UserId } from "@render-harness/core";
import type { Hono } from "hono";

export interface UsageRouteContext {
  pool: Pool;
  auth: (req: Request) => Promise<UserId | null>;
  pathPrefix: string;
}

export function registerUsageRoutes(app: Hono, ctx: UsageRouteContext): void {
  const { pool, auth, pathPrefix } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;

  app.get(r("/usage"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const url = new URL(c.req.url);
    const allUsers = url.searchParams.get("allUsers") === "1";
    const from = parseDate(url.searchParams.get("from"));
    const to = parseDate(url.searchParams.get("to"));
    const rollups = await aggregateUsage(pool, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(allUsers ? {} : { userId }),
    });
    return c.json({ rollups });
  });
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
