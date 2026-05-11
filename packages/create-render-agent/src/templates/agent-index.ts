/**
 * `agent/index.ts` for the scaffolded project. Identical for every shape
 * because the agent is YAML-driven (kind: builtin). Users who want
 * TypeScript tool handlers swap this for a `defineAgent({ ... })` call and
 * flip `agent.kind` to `custom` in render-harness.yaml.
 */
export function agentIndex(): string {
  return `/**
 * The agent definition for this entry.
 *
 * For YAML-driven entries (\`agent.kind: builtin\` in render-harness.yaml),
 * this file just calls \`defineFromConfig()\` and re-exports the result.
 *
 * For TS-driven entries (\`agent.kind: custom\`), replace this body with
 * a \`defineAgent({ ... })\` call and update the YAML to point at this
 * file:
 *
 *   agent:
 *     kind: custom
 *     entrypoint: ./agent/index.ts
 */

import { defineFromConfig } from "@render-harness/registry";

const { agent } = await defineFromConfig({
  configPath: new URL("../render-harness.yaml", import.meta.url).pathname,
});

export default agent;
export { agent };
`;
}
