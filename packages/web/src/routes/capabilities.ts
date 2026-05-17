import type {
  CapabilitiesResp,
  CapabilitySummary,
  DeploymentEnvVar,
  DeploymentInfo,
} from "@render-harness/contracts";
import type { AgentDefinition, UserId } from "@render-harness/core";
import type { Hono } from "hono";

export interface CapabilityRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  agents: Record<string, AgentDefinition>;
  pathPrefix: string;
  deployment?: DeploymentInfo;
}

export function registerCapabilityRoutes(app: Hono, ctx: CapabilityRouteContext): void {
  const r = (path: string) => `${ctx.pathPrefix}${path}`;

  app.get(r("/capabilities"), async (c) => {
    const userId = await ctx.auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    return c.json({ capabilities: summarizeCapabilities(ctx) } satisfies CapabilitiesResp);
  });
}

function summarizeCapabilities(ctx: CapabilityRouteContext): CapabilitySummary[] {
  const packNames = new Set<string>(ctx.deployment?.capabilityPacks ?? []);
  for (const agent of Object.values(ctx.agents)) {
    for (const pack of agent.capabilityPacks ?? []) packNames.add(pack);
  }

  return [...packNames].sort().map((pack) => {
    const shortName = stripPackScope(pack);
    const agents = Object.values(ctx.agents)
      .filter((agent) => (agent.capabilityPacks ?? []).includes(pack))
      .map((agent) => agent.name)
      .sort();
    return {
      pack,
      agents,
      localToolCount: countLocalTools(ctx.agents, shortName),
      mcpServerCount: countMcpServers(ctx.agents, shortName),
      envVars: envVarsForPack(ctx.deployment?.envSchema ?? [], shortName),
    };
  });
}

function countLocalTools(agents: Record<string, AgentDefinition>, shortName: string): number {
  let count = 0;
  for (const agent of Object.values(agents)) {
    count += (agent.localTools ?? []).filter(
      (tool) => tool.definition.source === `pack:${shortName}`,
    ).length;
  }
  return count;
}

function countMcpServers(agents: Record<string, AgentDefinition>, shortName: string): number {
  let count = 0;
  for (const agent of Object.values(agents)) {
    count += (agent.mcpServers ?? []).filter((server) =>
      server.name.startsWith(`${shortName}__`),
    ).length;
  }
  return count;
}

function envVarsForPack(envVars: DeploymentEnvVar[], shortName: string): DeploymentEnvVar[] {
  return envVars.filter(
    (envVar) => envVar.source === "capability" && envVar.packName === shortName,
  );
}

function stripPackScope(packName: string): string {
  return packName.replace(/^@[^/]+\//, "");
}
