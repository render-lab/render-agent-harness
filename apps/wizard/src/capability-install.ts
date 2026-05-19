/**
 * Wizard-side capability-install helpers. The canonical implementation
 * now lives in @render-harness/registry/repo-mutations so the harness's
 * own web routes can share it for the post-WIZARD_SHARED_SECRET deploy-key
 * commit path. This file re-exports the same symbols so existing wizard
 * imports keep working unchanged.
 */

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
} from "@render-harness/registry/repo-mutations";
