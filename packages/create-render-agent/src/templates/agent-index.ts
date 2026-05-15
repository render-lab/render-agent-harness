/**
 * `agent/index.ts` for the scaffolded project. The manifest's `agents[]`
 * is the canonical shape — even single-agent scaffolds declare one
 * agent in the list. This file calls `defineFromConfig()` and picks
 * the first (and usually only) agent for the runtime entry points to
 * import.
 *
 * For scaffolds with multiple agents (a bundle), each runtime entry
 * picks its own agent from `agentsById` directly; this file isn't
 * used. The wizard's bundle path scaffolds different entrypoints.
 */
export function agentIndex(): string {
  return `/**
 * The agent definition for this entry.
 *
 * For YAML-driven entries (\`agent.kind: builtin\` in render-harness.yaml),
 * this file calls \`defineFromConfig()\` and re-exports the first agent.
 *
 * For TS-driven entries (\`agent.kind: custom\`), replace this body with
 * a \`defineAgent({ ... })\` call and update the YAML to point at this
 * file:
 *
 *   agents:
 *     - id: my-agent
 *       agent:
 *         kind: custom
 *         entrypoint: ./agent/index.ts
 */

import { defineFromConfig, enrichDeploymentInfo, toDeploymentInfo } from "@render-harness/registry";

const configPath = new URL("../render-harness.yaml", import.meta.url).pathname;

const { agents, config, packs } = await defineFromConfig({ configPath });

const agent = agents[0];
if (!agent) {
  throw new Error("agent/index.ts: no agents defined in render-harness.yaml");
}

// enrichDeploymentInfo layers in wizardServiceUrl, repoLocator,
// envSchema (with isSet annotations), and renderService — everything
// the operator UI's Agents + Config tabs need. All fields are
// best-effort; missing pieces just hide the corresponding affordances.
const deployment = await enrichDeploymentInfo(toDeploymentInfo(config), configPath, {
  config,
  packs,
});

export default agent;
export { agent, deployment };
`;
}
