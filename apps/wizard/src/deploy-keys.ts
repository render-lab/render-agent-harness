/**
 * Wizard-side deploy-key helpers. Generation lives in
 * `@render-harness/registry/deploy-keys` so both the wizard scaffold
 * flow and the `create-render-agent deploy-key` CLI subcommand share
 * the same OpenSSH-format implementation; this module pairs that
 * generator with the Octokit call that registers the public key on a
 * managed GitHub repository.
 */

import type { Octokit } from "@octokit/rest";

export {
  type DeployKeypair,
  generateDeployKeypair,
} from "@render-harness/registry/deploy-keys";

export interface RegisterDeployKeyArgs {
  octokit: Octokit;
  org: string;
  repo: string;
  /** OpenSSH-format public key (e.g. `ssh-ed25519 AAAA... comment`). */
  publicSshKey: string;
  /** Human-readable label that appears in GitHub Settings → Deploy keys. */
  title: string;
  /**
   * Default false (write access). Read-only deploy keys can't push, so
   * the harness's edit-in-UI flows need write. We keep the option for
   * future read-only diagnostics.
   */
  readOnly?: boolean;
}

export async function registerDeployKey(
  args: RegisterDeployKeyArgs,
): Promise<{ id: number; verified: boolean }> {
  const { data } = await args.octokit.repos.createDeployKey({
    owner: args.org,
    repo: args.repo,
    title: args.title,
    key: args.publicSshKey,
    read_only: args.readOnly ?? false,
  });
  return { id: data.id, verified: data.verified };
}
