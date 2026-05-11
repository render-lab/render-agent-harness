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

export interface ErrorResponse {
  error: string;
  details?: string;
}
