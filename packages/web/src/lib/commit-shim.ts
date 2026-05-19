/**
 * Decision shim for the harness's edit-in-UI commit routes. Picks
 * between the post-V1 deploy-key path (commit directly via SSH) and the
 * legacy wizard proxy (commit via `WIZARD_SHARED_SECRET`).
 *
 * The deploy-key path is preferred when both `GITHUB_DEPLOY_KEY` and
 * `repoLocator.repoSshUrl` are set. When only the legacy creds are
 * present, the shim returns a sentinel that tells the route to fall
 * through to its existing wizard-proxy code.
 *
 * Note: in Wave 1, `agent-add` still requires the wizard proxy
 * regardless of deploy-key availability — it depends on
 * runtime-entries templates that live in `create-render-agent` and
 * aren't yet plumbed through the registry. `capability-install` and
 * `agent-model` are deploy-key-aware.
 */

import type { DeploymentInfo } from "@render-harness/contracts";

export type CommitPath =
  | { kind: "deploy_key"; repoSshUrl: string; deployKeyPem: string }
  | { kind: "wizard_proxy" }
  | { kind: "unconfigured"; reason: string };

export interface PickCommitPathOpts {
  deployment?: DeploymentInfo | undefined;
  wizardSharedSecret: string | null;
  env?: NodeJS.ProcessEnv;
}

export function pickCommitPath(opts: PickCommitPathOpts): CommitPath {
  const env = opts.env ?? process.env;
  const deployKey = env.GITHUB_DEPLOY_KEY ?? "";
  const repoSsh = opts.deployment?.repoLocator?.repoSshUrl ?? env.GITHUB_DEPLOY_REPO_SSH_URL ?? "";
  if (deployKey.length > 0 && repoSsh.length > 0) {
    return { kind: "deploy_key", repoSshUrl: repoSsh, deployKeyPem: deployKey };
  }
  if (opts.wizardSharedSecret && opts.wizardSharedSecret.length > 0) {
    return { kind: "wizard_proxy" };
  }
  // Note: we surface both env names so the operator UI's error
  // toaster can guide the user to either path. The deploy-key path is
  // the preferred one for new harnesses; the WIZARD_SHARED_SECRET path
  // is retained only for harnesses scaffolded before May 2026.
  return {
    kind: "unconfigured",
    reason:
      "set GITHUB_DEPLOY_KEY + GITHUB_DEPLOY_REPO_SSH_URL (preferred) or WIZARD_SHARED_SECRET (legacy)",
  };
}
