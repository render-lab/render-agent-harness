import type { AgentDefinition } from "./types.js";

/**
 * Identity helper for {@link AgentDefinition}. Exists to give the user IDE
 * autocomplete and to keep the import surface single-symbol.
 *
 * @example
 *   export const supportAgent = defineAgent({
 *     name: "support",
 *     version: "0.1.0",
 *     model: { provider: "anthropic", model: "claude-sonnet-4-6" },
 *     systemPrompt: "...",
 *     mcpServers: [...],
 *   });
 */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  validate(def);
  return def;
}

function validate(def: AgentDefinition): void {
  if (!def.name || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(def.name)) {
    throw new Error(`defineAgent: name "${def.name}" must match [a-z0-9][a-z0-9_-]{0,62}`);
  }
  if (!def.version) throw new Error("defineAgent: version is required");
  if (!def.model?.model) throw new Error("defineAgent: model.model is required");
  if (!def.systemPrompt?.trim()) {
    throw new Error("defineAgent: systemPrompt cannot be empty");
  }
  const requiresApproval = def.permissions?.requireApproval ?? [];
  const denied = new Set(def.permissions?.deniedTools ?? []);
  for (const t of requiresApproval) {
    if (denied.has(t)) {
      throw new Error(`defineAgent: tool "${t}" is in both requireApproval and deniedTools`);
    }
  }
  if (def.shape !== undefined && def.shape !== "chat" && def.shape !== "single-turn") {
    throw new Error(`defineAgent: shape must be "chat" or "single-turn" (got "${def.shape}")`);
  }
}
