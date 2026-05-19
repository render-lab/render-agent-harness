/**
 * @render-harness/registry — config registry for the Render agent harness.
 *
 * Two surfaces:
 *
 *   1. Runtime library — `defineFromConfig()` reads
 *      `render-harness.yaml`, resolves capability packs, and returns a
 *      runnable {@link AgentDefinition}. Imported by every YAML-driven
 *      entry's `agent/index.ts`.
 *
 *   2. Build bin — `render-harness-build` (see ./bin/build.ts) emits a
 *      `render.yaml` from the same config. Run by entry authors before
 *      committing.
 *
 * Both surfaces share the schemas and the capability-pack contract.
 */

// Re-exported so pack authors can `import type { MigrationFile } from
// "@render-harness/registry"` without depending on @render-harness/core
// directly. Convenience only — the canonical home is core.
export type { MigrationFile, PackMigration } from "@render-harness/core";
export { type DefineChatAgentOpts, defineChatAgent } from "./builtin-chat.js";
export {
  assertCapabilityPack,
  type CapabilityPack,
  type ConnectionRequirement,
  type ConnectorContribution,
  type ConnectorEnqueueConversationArgs,
  type ConnectorEnqueueResult,
  type ConnectorEnqueueRunArgs,
  type ConnectorWebCtx,
  definePack,
  namespacedMcpServerName,
  namespacedToolName,
  type PackContext,
  type RenderServiceSpec,
  RenderServiceSpecSchema,
} from "./capability.js";
export {
  type CapabilityCatalog,
  type CapabilityCatalogEntry,
  CapabilityCatalogEntrySchema,
  CapabilityCatalogSchema,
  type CapabilityConnectorMetadata,
  CapabilityConnectorMetadataSchema,
  type CapabilityFeature,
  CapabilityFeatureSchema,
  type CapabilityPermissionProfile,
  CapabilityPermissionProfileSchema,
  type CapabilityQuality,
  CapabilityQualitySchema,
  type CapabilityTrustTier,
  CapabilityTrustTierSchema,
  loadCapabilityCatalog,
  parseCapabilityCatalogJson,
  parseCapabilityCatalogYaml,
  serializeCapabilityCatalog,
} from "./capability-index.js";
export {
  type CapabilityPackageJson,
  type CapabilityValidationIssue,
  type CapabilityValidationResult,
  type CapabilityValidationSeverity,
  validateCapabilityPack,
  validateCapabilityPackageDir,
  validateCapabilityPackageMetadata,
  validateConnectorKey,
} from "./capability-validate.js";
export { type DeployKeypair, generateDeployKeypair } from "./deploy-keys.js";
export { enrichDeploymentInfo, toDeploymentInfo } from "./deployment-info.js";
export {
  type GalleryAgentEntryInput,
  GalleryAgentEntrySchema,
  type GalleryEntryKind,
  type GalleryIndex,
  GalleryIndexSchema,
  type GalleryRuntimeKind,
  loadGalleryFromBundle,
  loadGalleryFromSource,
  type ResolvedAgentEntry,
  type ResolvedCapabilityEntry,
  type ResolvedGallery,
  ResolvedGallerySchema,
  serializeGallery,
} from "./gallery.js";
export {
  buildHarnessVersionInfo,
  CORE_HARNESS_PACKAGES,
  readPackageVersion,
} from "./harness-version.js";
export { type EnvLookup, interpolate, interpolateTree } from "./interpolate.js";
export {
  type DefineFromConfigOpts,
  type DefineFromConfigResult,
  defineFromConfig,
} from "./load-config.js";
export { type LoadedPack, type LoadPacksOpts, loadPacks, makePackContext } from "./load-pack.js";
export {
  BASE_URL_ALLOWLIST,
  DEFAULT_MODEL_PRESET_ID,
  findPreset,
  MODEL_PRESETS,
  type ModelPreset,
  matchPreset,
} from "./model-presets.js";
export {
  type AgentBlockInput,
  type AgentEntryInput,
  AgentEntrySchema,
  type BudgetInput,
  type CapabilityRef,
  CapabilityRefSchema,
  type EnvVarSpec,
  EnvVarSpecSchema,
  flattenRuntimeKinds,
  type HarnessConfig,
  HarnessConfigSchema,
  type IndexEntry,
  IndexEntrySchema,
  type IndexFile,
  IndexSchema,
  isWorkflowTaskAgent,
  type McpServerConfigInput,
  McpServerConfigSchema,
  type ModelSpecInput,
  ModelSpecSchema,
  type PermissionsInput,
  PermissionsSchema,
  parseHarnessConfigYaml,
  parseIndexJson,
  type RuntimeBlockInput,
  RuntimeBlockSchema,
  type SamplingParamsInput,
  SamplingParamsSchema,
  type SharedBlockInput,
  SharedBlockSchema,
  workflowTaskAgents,
} from "./schema.js";
