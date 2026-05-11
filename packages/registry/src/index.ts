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

export {
  type CapabilityPack,
  type PackContext,
  type RenderServiceSpec,
  RenderServiceSpecSchema,
  assertCapabilityPack,
  definePack,
  namespacedMcpServerName,
  namespacedToolName,
} from "./capability.js";
export { type DefineChatAgentOpts, defineChatAgent } from "./builtin-chat.js";
export {
  type DefineFromConfigOpts,
  type DefineFromConfigResult,
  defineFromConfig,
} from "./load-config.js";
export { type LoadedPack, type LoadPacksOpts, loadPacks, makePackContext } from "./load-pack.js";
export {
  type GalleryAgentEntryInput,
  GalleryAgentEntrySchema,
  type GalleryIndex,
  GalleryIndexSchema,
  type GalleryRuntimeKind,
  type ResolvedAgentEntry,
  type ResolvedCapabilityEntry,
  type ResolvedGallery,
  ResolvedGallerySchema,
  loadGalleryFromBundle,
  loadGalleryFromSource,
  serializeGallery,
} from "./gallery.js";
export { type EnvLookup, interpolate, interpolateTree } from "./interpolate.js";
export {
  type AgentBlockInput,
  type BudgetInput,
  type CapabilityRef,
  CapabilityRefSchema,
  type EnvVarSpec,
  EnvVarSpecSchema,
  type HarnessConfig,
  HarnessConfigSchema,
  type IndexEntry,
  IndexEntrySchema,
  type IndexFile,
  IndexSchema,
  type McpServerConfigInput,
  McpServerConfigSchema,
  type ModelSpecInput,
  ModelSpecSchema,
  type PermissionsInput,
  PermissionsSchema,
  type RuntimeBlockInput,
  RuntimeBlockSchema,
  type SamplingParamsInput,
  SamplingParamsSchema,
  parseHarnessConfigYaml,
  parseIndexJson,
} from "./schema.js";
