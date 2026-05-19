/**
 * Pure helpers for editing the three core files in a managed harness
 * repo (`render-harness.yaml`, `package.json`, `.env.example`) and for
 * planning the multi-file mutations the edit-in-UI flows perform.
 *
 * Lives in @render-harness/registry so two consumers share one
 * implementation:
 *
 *   1. `@render-harness/wizard` — the V1 server-to-server proxy path,
 *      where the wizard reads files via Octokit, mutates, and commits
 *      with its central GitHub App installation token.
 *   2. `@render-harness/web` — the post-V1 deploy-key path, where the
 *      harness clones its own repo via SSH, runs the same mutations
 *      in-process, and pushes back with its per-deployment deploy key.
 *
 * Both paths call exactly the same planner + mutator functions, so the
 * edit semantics are identical regardless of who is doing the commit.
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
} from "./agent-add.js";
export {
  type CapabilityAccessMode,
  CapabilityInstallError,
  type CapabilityInstallInput,
  type CapabilityInstallPlan,
  type CapabilityInstallSpec,
  type ExpandAllowedToolsArgs,
  type ExpandAllowedToolsResult,
  expandAllowedToolsForPacks,
  mutateCapabilityInstallYaml,
  mutateEnvExample,
  mutatePackageJsonAddDependency,
  OFFICIAL_CAPABILITY_INSTALLS,
  planCapabilityInstall,
  TIER_A_BUILTIN_TOOLS,
} from "./capability-install.js";

export {
  AgentNotEditableError,
  AgentNotFoundError,
  InvalidManifestError,
  type MutateAgentModelOpts,
  type MutateAgentSystemPromptOpts,
  mutateAgentModel,
  mutateAgentSystemPrompt,
} from "./yaml-edit.js";
