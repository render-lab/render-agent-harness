/**
 * Wizard-side YAML edit helpers. Canonical implementation in
 * @render-harness/registry/repo-mutations — see capability-install.ts
 * for the rationale.
 */

export {
  AgentNotFoundError,
  InvalidManifestError,
  type MutateAgentModelOpts,
  mutateAgentModel,
} from "@render-harness/registry/repo-mutations";
