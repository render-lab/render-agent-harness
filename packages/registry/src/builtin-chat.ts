/**
 * The `chat` built-in agent kind.
 *
 * The simplest viable agent: system prompt + model + (optional) MCP
 * servers. No local tools, no skills directory. Lives in the registry
 * package rather than @render-harness/core because it's a YAML-side
 * convenience, not a core primitive.
 *
 * Two ways to use it:
 *
 *   - YAML-driven: declare `agent: { kind: builtin, ref: chat,
 *     systemPrompt: ... }` in render-harness.yaml. The registry's
 *     `defineFromConfig()` invokes this internally.
 *
 *   - TS-driven: import `defineChatAgent` and call it directly from a
 *     TS entrypoint that wants the same prompt-only shape without the
 *     YAML round-trip.
 */

import type {
  AgentDefinition,
  Budget,
  McpServerConfig,
  ModelSpec,
  Permissions,
  SamplingParams,
} from "@render-harness/core";
import { defineAgent } from "@render-harness/core";

export interface DefineChatAgentOpts {
  name: string;
  version?: string;
  model: ModelSpec;
  systemPrompt: string;
  mcpServers?: McpServerConfig[];
  permissions?: Permissions;
  budget?: Partial<Budget>;
  sampling?: SamplingParams;
}

/**
 * Build a chat-shaped {@link AgentDefinition}: system prompt + model +
 * (optional) MCP servers. No local tools, no skills.
 */
export function defineChatAgent(opts: DefineChatAgentOpts): AgentDefinition {
  const def: AgentDefinition = {
    name: opts.name,
    version: opts.version ?? "0.1.0",
    model: opts.model,
    systemPrompt: opts.systemPrompt,
  };
  if (opts.mcpServers) def.mcpServers = opts.mcpServers;
  if (opts.permissions) def.permissions = opts.permissions;
  if (opts.budget) def.budget = opts.budget;
  if (opts.sampling) def.sampling = opts.sampling;
  return defineAgent(def);
}
