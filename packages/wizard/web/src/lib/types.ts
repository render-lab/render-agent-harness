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

export interface WizardState {
  templateSlug: string | null;
  agentName: string;
  description: string;
  systemPrompt: string;
  model: string;
  runtimes: RuntimeSelection[];
  ui: boolean;
  capabilities: CapabilityPick[];
}

export interface GalleryAgent {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  runtimeKinds: RuntimeKind[] | ReadonlyArray<RuntimeKind | "workflows">;
  capabilities: string[];
  author: string | null;
  manifest: {
    agent:
      | { kind: "builtin"; ref: "chat"; systemPrompt: string }
      | { kind: "custom"; entrypoint: string };
    model: { provider: string; model: string };
  };
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
