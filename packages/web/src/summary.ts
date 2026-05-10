import { type AgentDefinition, previewBuiltins, type SkippedBuiltin } from "@render-harness/core";

const SYSTEM_PROMPT_PREVIEW_CHARS = 400;

export interface AgentSummary {
  name: string;
  version: string;
  model: { provider: string; model: string };
  systemPromptPreview: string;
  systemPromptLength: number;
  mcpServers: { name: string; transport: "stdio" | "http" }[];
  permissions: {
    allowedTools?: string[];
    deniedTools?: string[];
    requireApproval?: string[];
  };
  budget?: AgentDefinition["budget"];
  sampling?: AgentDefinition["sampling"];
  hasLocalTools: boolean;
  hasSkills: boolean;
  /**
   * Builtin tools registered for this agent given the current process env,
   * with the agent's own deniedTools / allowedTools applied. Names that
   * would otherwise register but are blocked by permissions appear under
   * `builtinsSkipped` with reason `"denied by agent permissions"`.
   */
  builtinsRegistered: string[];
  builtinsSkipped: SkippedBuiltin[];
  /**
   * Capability pack names declared on the agent (via `defineAgent`'s
   * `capabilityPacks` field). Pure metadata — the harness uses this only
   * to surface "this agent uses Pack X" in the operator UI.
   */
  capabilityPacks: string[];
}

export function summariseAgent(agent: AgentDefinition): AgentSummary {
  const fullPrompt = agent.systemPrompt ?? "";
  const preview =
    fullPrompt.length > SYSTEM_PROMPT_PREVIEW_CHARS
      ? `${fullPrompt.slice(0, SYSTEM_PROMPT_PREVIEW_CHARS)}…`
      : fullPrompt;

  const builtinsPreview = previewBuiltins(process.env);
  const denied = new Set(agent.permissions?.deniedTools ?? []);
  const allowed = agent.permissions?.allowedTools;
  const builtinsRegistered: string[] = [];
  const builtinsSkipped: SkippedBuiltin[] = [...builtinsPreview.skipped];
  for (const name of builtinsPreview.registered) {
    if (denied.has(name)) {
      builtinsSkipped.push({ name, reason: "denied by agent permissions" });
      continue;
    }
    if (allowed && allowed.length > 0 && !allowed.includes(name)) {
      builtinsSkipped.push({ name, reason: "not in agent allowedTools" });
      continue;
    }
    builtinsRegistered.push(name);
  }

  const summary: AgentSummary = {
    name: agent.name,
    version: agent.version,
    model: { provider: agent.model.provider, model: agent.model.model },
    systemPromptPreview: preview,
    systemPromptLength: fullPrompt.length,
    mcpServers: (agent.mcpServers ?? []).map((s) => ({
      name: s.name,
      transport: s.transport,
    })),
    permissions: {
      ...(agent.permissions?.allowedTools ? { allowedTools: agent.permissions.allowedTools } : {}),
      ...(agent.permissions?.deniedTools ? { deniedTools: agent.permissions.deniedTools } : {}),
      ...(agent.permissions?.requireApproval
        ? { requireApproval: agent.permissions.requireApproval }
        : {}),
    },
    hasLocalTools: (agent.localTools ?? []).length > 0,
    hasSkills: agent.skills !== undefined,
    builtinsRegistered,
    builtinsSkipped,
    capabilityPacks: [...(agent.capabilityPacks ?? [])],
  };
  if (agent.budget) summary.budget = agent.budget;
  if (agent.sampling) summary.sampling = agent.sampling;
  return summary;
}
