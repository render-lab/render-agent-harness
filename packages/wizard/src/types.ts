/**
 * Shared types between the wizard server and its SPA. The wire shape is
 * intentionally a subset of `Answers` from `create-render-agent`: server
 * fills in the fields the SPA shouldn't be choosing (packageManager,
 * gitInit, installDeps, harnessRoot, templateManifest).
 */
import type { Answers } from "create-render-agent";

export interface ScaffoldRequest {
  agentName: string;
  description: string;
  systemPrompt: string;
  model: Answers["model"];
  runtimes: Answers["runtimes"];
  capabilities: Answers["capabilities"];
  ui: boolean;
  /** Slug of a gallery agent the user picked, or null for blank. */
  templateSlug: string | null;
  /**
   * When set, the server treats the request as a sealed-bundle scaffold:
   * it pulls the bundle's manifest + sourceFiles from its in-memory
   * gallery by slug and bypasses the per-agent fields above. The
   * `templateSlug` field carries the same slug for backwards-compatible
   * analytics. Single-agent picks leave this null.
   */
  bundleSlug: string | null;
  /** Cloudflare Turnstile token from the client widget. Verified server-side. */
  turnstileToken: string;
}

export interface ScaffoldResponse {
  /** Public HTML URL of the managed repo. */
  repoUrl: string;
  /** One-click Render Blueprint deploy URL. */
  deployUrl: string;
  /** Random slug used for the managed repo (e.g. "my-agent-7af3"). */
  repoSlug: string;
}

export interface ScaffoldJobResponse {
  jobId: string;
}

export type ScaffoldPhase =
  | "building_file_map"
  | "generating_blueprint"
  | "authenticating_github"
  | "creating_repo"
  | "repo_created"
  | "writing_files"
  | "done"
  | "error";

export type ScaffoldProgressEvent =
  | {
      type: "progress";
      phase: Exclude<ScaffoldPhase, "done" | "error">;
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

export interface ErrorResponse {
  error: string;
  details?: string;
}
