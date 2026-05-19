/**
 * Wizard-side agent-add helpers. Canonical implementation in
 * @render-harness/registry/repo-mutations — see capability-install.ts
 * for the rationale.
 */

export {
  type AddableAgent,
  type AgentAddCapabilitySpec,
  type AgentAddEnvAddition,
  AgentAddError,
  type AgentAddPlan,
  type AgentAddSource,
  type AgentAddSpec,
  listAddableAgents,
  mutateEnvExampleForAgent,
  mutateManifestForAgentAdd,
  mutatePackageJsonAddDeps,
  mutatePackageJsonAddRuntimeDeps,
  type PlanAgentAddArgs,
  planAgentAdd,
} from "@render-harness/registry/repo-mutations";
