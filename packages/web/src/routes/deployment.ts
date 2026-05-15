import type {
  DeploymentAgentInfo,
  DeploymentAgentRuntime,
  DeploymentInfo,
} from "@render-harness/contracts";
import type { AgentDefinition, UserId } from "@render-harness/core";
import type { Hono } from "hono";

export interface DeploymentRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  agents: Record<string, AgentDefinition>;
  pathPrefix: string;
  /**
   * Caller-supplied deployment info, typically derived from the loaded
   * `render-harness.yaml`. When omitted we synthesize a minimal shape
   * from the agents map so the endpoint always responds — the Guide
   * gracefully degrades to a single-agent narrative in that case.
   */
  deployment?: DeploymentInfo;
}

export function registerDeploymentRoutes(app: Hono, ctx: DeploymentRouteContext): void {
  const { auth, agents, pathPrefix, deployment } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;

  app.get(r("/deployment"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    return c.json(deployment ?? fallbackDeployment(agents));
  });
}

/**
 * When the caller didn't supply a manifest-derived DeploymentInfo, we
 * still return *something* useful: bundle name = the single agent's
 * name (or "agents" for multi), each agent listed without runtimes
 * (we can't know the trigger topology from the AgentDefinition alone).
 */
function fallbackDeployment(agents: Record<string, AgentDefinition>): DeploymentInfo {
  const values = Object.values(agents);
  const name = values.length === 1 && values[0] ? values[0].name : "agents";
  const list: DeploymentAgentInfo[] = values.map((a) => ({
    id: a.name,
    name: a.name,
    runtimes: [] as DeploymentAgentRuntime[],
    workflowTask: false,
  }));
  return { name, agents: list };
}
