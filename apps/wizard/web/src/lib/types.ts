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
  surface: string[];
  audience: string[];
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

export type BrowseItem =
  | {
      source: "official";
      id: string;
      name: string;
      description: string;
      /** Standardized closed-set taxonomy authored in gallery/index.yaml. */
      surface: string[];
      audience: string[];
      runtimeKinds: string[];
      capabilities: string[];
      author: string | null;
      templateSlug: string;
      kind: GalleryEntryKind;
      readme: string | null;
    }
  | {
      source: "community";
      id: string;
      name: string;
      description: string;
      /** Free-form tags inherited from the community entry's own schema. */
      categories: string[];
      runtimeKinds: string[];
      capabilities: string[];
      author: string | null;
      repo: string;
      ref: string;
      deployUrl: string;
    };

export interface BrowseFacets {
  sources: string[];
  runtimeKinds: string[];
  surfaces: string[];
  audiences: string[];
  categories: string[];
  capabilities: string[];
  kinds: string[];
}

export interface BrowseResponse {
  items: BrowseItem[];
  facets: BrowseFacets;
  community: {
    indexConfigured: boolean;
    entryCount: number;
    error: string | null;
  };
}

export interface ScaffoldResponse {
  repoUrl: string;
  deployUrl: string;
  repoSlug: string;
  /**
   * When the scaffold was anonymous, the wizard emits a signed one-time
   * URL the user can hit later (after signing in) to claim the repo and
   * trigger the same collaborator-add + ownership-row insert that an
   * authed scaffold would have done inline.
   */
  claimUrl?: string;
  /**
   * Per-harness SSH deploy key the wizard provisioned for edit-in-UI
   * commits. The Success step displays `privatePem` + `repoSshUrl` with
   * copy buttons so the operator can paste them into the Render
   * Blueprint prompt for `GITHUB_DEPLOY_KEY` + `GITHUB_DEPLOY_REPO_SSH_URL`.
   */
  deployKey?: {
    privatePem: string;
    publicSshKey: string;
    fingerprint: string;
    repoSshUrl: string;
  };
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
        | "writing_files"
        | "creating_deploy_key";
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
