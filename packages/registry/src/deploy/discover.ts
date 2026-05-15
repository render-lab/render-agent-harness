/**
 * Discovers contextual info the deploy command needs but doesn't ask
 * the user to type:
 *
 *   - Git remote URL (which repo Render's services point at)
 *   - Git branch (what to auto-deploy from)
 *   - Render owner id (from RENDER_OWNER_ID env, or via API if unset
 *     AND the API key only has access to one workspace)
 */

import { execSync } from "node:child_process";
import type { RenderApi } from "./api.js";

export interface DiscoveredContext {
  ownerId: string;
  repoUrl: string;
  branch: string;
}

export interface DiscoverOpts {
  projectRoot: string;
  api: RenderApi;
  /** Override: skip git discovery and use this URL. */
  repoOverride?: string;
  /** Override: skip git discovery and use this branch. */
  branchOverride?: string;
  /** Override: use this owner id instead of auto-discovery / RENDER_OWNER_ID. */
  ownerIdOverride?: string;
  env?: NodeJS.ProcessEnv;
}

export async function discoverContext(opts: DiscoverOpts): Promise<DiscoveredContext> {
  const env = opts.env ?? process.env;
  const repoUrl = opts.repoOverride ?? readGitRemote(opts.projectRoot, "origin");
  if (!repoUrl) {
    throw new Error(
      `deploy: could not read git remote "origin" from ${opts.projectRoot}. ` +
        `Push the repo to GitHub first, or pass --repo <url>.`,
    );
  }

  const branch = opts.branchOverride ?? readGitBranch(opts.projectRoot);
  if (!branch) {
    throw new Error(
      `deploy: could not read current git branch in ${opts.projectRoot}. ` +
        `Make sure you're inside a git repo, or pass --branch <name>.`,
    );
  }

  const ownerId = opts.ownerIdOverride ?? env.RENDER_OWNER_ID ?? (await discoverOwner(opts.api));

  return { ownerId, repoUrl, branch };
}

function readGitRemote(cwd: string, remoteName: string): string | null {
  try {
    return execSync(`git remote get-url ${remoteName}`, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function readGitBranch(cwd: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

async function discoverOwner(api: RenderApi): Promise<string> {
  const owners = await api.listOwners();
  if (owners.length === 0) {
    throw new Error(
      "deploy: no Render workspaces visible to this API key. Set RENDER_OWNER_ID explicitly or check your API key permissions.",
    );
  }
  if (owners.length === 1) {
    const only = owners[0];
    if (!only) throw new Error("deploy: unreachable — owners[0] is undefined");
    return only.id;
  }
  const list = owners.map((o) => `  - ${o.name} (${o.id})`).join("\n");
  throw new Error(
    `deploy: this API key has access to multiple workspaces; set RENDER_OWNER_ID to one of:\n${list}`,
  );
}
