/**
 * Wire types that mirror the server's, plus the SPA's own state shape.
 * Imported by step components and the API client.
 */

export type RuntimeKind = "web" | "worker" | "cron";

export type RuntimeSelection =
  | { kind: "web" }
  | { kind: "cron"; schedule: string }
  | { kind: "worker"; queue: string };

export interface CapabilityPick {
  pack: string;
}

/**
 * Full model spec emitted to render-harness.yaml. Mirrors
 * `ModelSpecInput` from `@render-harness/registry/schema` but defined
 * locally so the SPA bundle doesn't pull in the zod runtime.
 */
export interface ModelSpec {
  provider: "anthropic" | "openai-compat";
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
}

export interface WizardState {
  templateSlug: string | null;
  agentName: string;
  description: string;
  systemPrompt: string;
  /** Currently-picked preset id. "custom" routes to the sub-form. */
  modelPresetId: string;
  /** Full model spec emitted to YAML on submit. */
  model: ModelSpec;
  runtimes: RuntimeSelection[];
  ui: boolean;
  capabilities: CapabilityPick[];
}

export type GalleryEntryKind = "agent" | "bundle";

interface ManifestAgent {
  id: string;
  description?: string;
  agent:
    | { kind: "builtin"; ref: "chat"; systemPrompt: string }
    | { kind: "custom"; entrypoint: string };
  model?: ModelSpec;
}

export interface GalleryAgent {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  runtimeKinds: RuntimeKind[] | ReadonlyArray<RuntimeKind | "workflows">;
  capabilities: string[];
  author: string | null;
  /** Discriminator: "bundle" templates are sealed (multi-agent / verbatim source tree). */
  kind: GalleryEntryKind;
  manifest: {
    name: string;
    agents: ManifestAgent[];
    shared?: { model?: ModelSpec; ui?: boolean };
  };
  /** Verbatim source files for bundle templates; empty for single-agent. */
  sourceFiles: Record<string, string>;
  readme: string | null;
}

export interface GalleryCapability {
  pack: string;
  description: string;
  label: string;
  envHint: string | null;
}

export interface Gallery {
  schemaVersion: 1;
  agents: GalleryAgent[];
  capabilities: GalleryCapability[];
}

export interface ScaffoldResponse {
  repoUrl: string;
  deployUrl: string;
  repoSlug: string;
}

export interface ScaffoldJobResponse {
  jobId: string;
}

export type ScaffoldProgressEvent =
  | {
      type: "progress";
      phase:
        | "building_file_map"
        | "generating_blueprint"
        | "authenticating_github"
        | "creating_repo"
        | "repo_created"
        | "writing_files";
      message: string;
      at: string;
      index?: number;
      total?: number;
    }
  | {
      type: "done";
      phase: "done";
      message: string;
      at: string;
      result: ScaffoldResponse;
    }
  | {
      type: "error";
      phase: "error";
      message: string;
      at: string;
      error: string;
      details?: string;
    };
