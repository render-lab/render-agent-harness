/**
 * The agent definition for this entry.
 *
 * For YAML-driven entries (`agent.kind: builtin` in render-harness.yaml),
 * this file just calls `defineFromConfig()` and re-exports the result.
 *
 * For TS-driven entries (`agent.kind: custom`), replace this body with
 * a `defineAgent({ ... })` call (see examples/* in the harness repo)
 * and update the YAML to point at this file:
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
