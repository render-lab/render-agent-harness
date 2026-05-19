/**
 * Wizard-side YAML edit helpers. Canonical implementation in
 * @render-harness/registry/repo-mutations — see capability-install.ts
 * for the rationale.
 */

export {
  AgentNotEditableError,
  AgentNotFoundError,
  InvalidManifestError,
  type MutateAgentModelOpts,
  mutateAgentModel,
  type MutateAgentSystemPromptOpts,
  mutateAgentSystemPrompt,
} from "@render-harness/registry/repo-mutations";
