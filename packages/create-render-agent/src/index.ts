export { resolveGallery } from "./gallery.js";
export {
  type Answers,
  addBlueprintFilesToMap,
  buildFileMap,
  type GenerateResult,
  generate,
  removeLocalEnvFile,
} from "./generate.js";
export { runWizard } from "./prompts.js";
// The bundle-runtime entry templates are re-exported so the wizard's
// agent-add route can drop the correct `src/<kind>.ts` into a managed
// harness when a newly added agent introduces a runtime kind the
// project doesn't yet have a build entry for.
export {
  bundleCronEntry,
  bundleCronTriggerEntry,
  bundleWebEntry,
  bundleWorkerEntry,
  bundleWorkflowsEntry,
} from "./templates/bundle.js";
export type {
  CapabilityPick,
  PackageManager,
  RuntimeKind,
  RuntimeSelection,
} from "./types.js";
