import type { AgentDefinition, UserId } from "@render-harness/core";
import type { Hono } from "hono";
import { summariseAgent } from "../summary.js";

export interface AgentsRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  agents: Record<string, AgentDefinition>;
  pathPrefix: string;
}

export function registerAgentsRoutes(app: Hono, ctx: AgentsRouteContext): void {
  const { auth, agents, pathPrefix } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;

  app.get(r("/agents"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    return c.json({ agents: Object.values(agents).map(summariseAgent) });
  });
}
