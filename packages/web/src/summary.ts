import type { AgentModelSummary, AgentSummary } from "@render-harness/contracts";
import { type AgentDefinition, previewBuiltins, type SkippedBuiltin } from "@render-harness/core";

export type { AgentSummary };

const SYSTEM_PROMPT_PREVIEW_CHARS = 400;

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

  const model: AgentModelSummary = {
    provider: agent.model.provider,
    model: agent.model.model,
  };
  if (agent.model.baseURL) model.baseURL = agent.model.baseURL;
  if (agent.model.apiKeyEnv) model.apiKeyEnv = agent.model.apiKeyEnv;
  if (agent.model.thinking) model.thinking = { ...agent.model.thinking };

  const summary: AgentSummary = {
    name: agent.name,
    version: agent.version,
    agentId: agent.name,
    model,
    systemPromptPreview: preview,
    systemPrompt: fullPrompt,
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
  if (agent.source) summary.source = { ...agent.source };
  return summary;
}
