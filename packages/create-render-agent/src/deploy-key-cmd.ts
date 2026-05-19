/**
 * `create-render-agent deploy-key` subcommand. Generates an ed25519
 * SSH deploy keypair and prints both halves with paste-ready
 * instructions for enabling edit-in-UI on a CLI-scaffolded harness.
 *
 * The generator itself lives in @render-harness/registry/deploy-keys
 * so the wizard's scaffold-time keypair flow and this CLI subcommand
 * stay byte-identical (OpenSSH PEM format that `ssh -i` will load on
 * Render's runtime).
 *
 * Usage:
 *   npx create-render-agent deploy-key
 *   npx create-render-agent deploy-key --repo render-lab-agents/my-agent-7af3
 *   npx create-render-agent deploy-key --comment "my-agent prod"
 *
 * Output is plain text designed to copy-paste into:
 *   - GitHub repo Settings -> Deploy keys (the public-key block)
 *   - Render service Environment tab (GITHUB_DEPLOY_KEY value)
 *   - Render service Environment tab (GITHUB_DEPLOY_REPO_SSH_URL value)
 *
 * No file writes. The CLI never persists either half to disk — leaving
 * a private key sitting on the operator's filesystem is the wrong
 * default.
 */

import { generateDeployKeypair } from "@render-harness/registry/deploy-keys";

export interface DeployKeyCommandArgs {
  /**
   * GitHub `owner/name` slug for the repo. When set, the printout
   * tailors the GitHub deploy-key URL and pre-fills
   * `GITHUB_DEPLOY_REPO_SSH_URL` for the operator to copy.
   */
  repo?: string;
  /**
   * Comment that lands in the SSH key (visible in GitHub's deploy-key
   * list). Default is `render-harness`. Keep short; spaces collapsed
   * by the generator.
   */
  comment?: string;
}

export interface DeployKeyCommandOutput {
  publicSshKey: string;
  privatePem: string;
  fingerprint: string;
  repoSshUrl: string | null;
  text: string;
}

export function runDeployKeyCommand(args: DeployKeyCommandArgs = {}): DeployKeyCommandOutput {
  const repoSlug = args.repo?.trim() ?? "";
  const isValidRepoSlug = /^[^/\s]+\/[^/\s]+$/.test(repoSlug);
  if (repoSlug && !isValidRepoSlug) {
    throw new Error(
      `--repo expects "<owner>/<name>" (e.g. render-lab-agents/my-agent-7af3); got "${repoSlug}"`,
    );
  }
  const repoSshUrl = isValidRepoSlug ? `git@github.com:${repoSlug}.git` : null;
  const keypair = generateDeployKeypair(args.comment ?? "render-harness");

  const ghKeysUrl = isValidRepoSlug
    ? `https://github.com/${repoSlug}/settings/keys/new`
    : "https://github.com/<owner>/<repo>/settings/keys/new";
  const renderEnvHint = isValidRepoSlug
    ? `git@github.com:${repoSlug}.git`
    : "git@github.com:<owner>/<repo>.git";

  const text = [
    "# Render Harness deploy key",
    "",
    `Fingerprint: ${keypair.fingerprint}`,
    "",
    "## 1. Add the public key to GitHub",
    "",
    `Open: ${ghKeysUrl}`,
    "Title:    render-harness-bot",
    'Key:      (paste the block below; check "Allow write access")',
    "",
    keypair.publicSshKey,
    "",
    "## 2. Add the private key + repo URL to your Render service env",
    "",
    "Dashboard -> your service -> Environment -> Add Environment Variable",
    "",
    "Key:   GITHUB_DEPLOY_KEY",
    "Value: (paste the entire OPENSSH PRIVATE KEY block below, including the header/footer lines)",
    "",
    keypair.privatePem.trimEnd(),
    "",
    "Key:   GITHUB_DEPLOY_REPO_SSH_URL",
    `Value: ${renderEnvHint}`,
    "",
    "## Notes",
    "",
    "- Edit-in-UI (Install capability, Edit model) only works when both env vars are set on the deployed service AND the public key has write access on the repo.",
    '- If the operator UI says "edit_in_ui_not_configured", check that both env vars are set and the service has restarted since you added them.',
    "- This is a one-time setup per harness. To rotate the key later, generate a new pair, replace the GitHub deploy key (remove the old one), and update GITHUB_DEPLOY_KEY in Render env.",
    "- The private key was generated in-memory and never written to disk; copy it now or rerun this command to generate a fresh one.",
  ].join("\n");

  return {
    publicSshKey: keypair.publicSshKey,
    privatePem: keypair.privatePem,
    fingerprint: keypair.fingerprint,
    repoSshUrl,
    text,
  };
}

export function parseDeployKeyArgs(argv: ReadonlyArray<string>): DeployKeyCommandArgs {
  const args: DeployKeyCommandArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--repo") {
      const value = argv[i + 1];
      if (!value) throw new Error("--repo requires a value (owner/name)");
      args.repo = value;
      i += 1;
    } else if (token?.startsWith("--repo=")) {
      args.repo = token.slice("--repo=".length);
    } else if (token === "--comment") {
      const value = argv[i + 1];
      if (!value) throw new Error("--comment requires a value");
      args.comment = value;
      i += 1;
    } else if (token?.startsWith("--comment=")) {
      args.comment = token.slice("--comment=".length);
    } else if (token && token !== "deploy-key") {
      throw new Error(`unknown deploy-key flag: ${token}`);
    }
  }
  return args;
}
