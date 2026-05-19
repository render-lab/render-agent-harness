/**
 * Wizard-side re-export of the runtime-entries helpers. Canonical
 * implementation now lives in @render-harness/registry/runtime-entries
 * so the harness's deploy-key commit path can share it. This shim
 * keeps existing wizard imports working unchanged.
 */

export {
  type EnsureTsupEntriesResult,
  ensureTsupEntries,
  type RequiredEntry,
  requiredEntries,
} from "@render-harness/registry/runtime-entries";
