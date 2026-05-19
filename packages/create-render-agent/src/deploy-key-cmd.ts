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
 * When `--repo owner/name` is supplied AND the `gh` CLI is on PATH AND
 * the operator is already authenticated, the public half is registered
 * on the repo automatically via `gh api -X POST repos/.../keys`. The
 * "paste into GitHub" section of the printout is then replaced with a
 * confirmation line so the operator only has to handle the private
 * half (Render env). Pass `--no-gh` to opt out and always print the
 * manual instructions.
 *
 * Usage:
 *   npx create-render-agent deploy-key
 *   npx create-render-agent deploy-key --repo render-lab-agents/my-agent-7af3
 *   npx create-render-agent deploy-key --repo owner/name --no-gh
 *   npx create-render-agent deploy-key --comment "my-agent prod"
 *
 * Output is plain text designed to copy-paste into:
 *   - GitHub repo Settings -> Deploy keys (the public-key block, when
 *     gh-registration didn't run)
 *   - Render service Environment tab (GITHUB_DEPLOY_KEY value)
 *   - Render service Environment tab (GITHUB_DEPLOY_REPO_SSH_URL value)
 *
 * No file writes. The CLI never persists either half to disk — leaving
 * a private key sitting on the operator's filesystem is the wrong
 * default.
 */

import { spawnSync } from "node:child_process";
import { generateDeployKeypair } from "@render-harness/registry/deploy-keys";

export interface DeployKeyCommandArgs {
  /**
   * GitHub `owner/name` slug for the repo. When set, the printout
   * tailors the GitHub deploy-key URL and pre-fills
   * `GITHUB_DEPLOY_REPO_SSH_URL` for the operator to copy. Required
   * for the gh-auto-register path.
   */
  repo?: string;
  /**
   * Comment that lands in the SSH key (visible in GitHub's deploy-key
   * list). Default is `render-harness`. Keep short; spaces collapsed
   * by the generator.
   */
  comment?: string;
  /**
   * When true, skip the gh-CLI auto-register attempt and always print
   * the manual paste-into-GitHub instructions. Useful for testing, for
   * operators who explicitly want the manual flow, or when `gh` is
   * installed but they don't want it to touch the repo.
   */
  noGh?: boolean;
}

export interface DeployKeyCommandOutput {
  publicSshKey: string;
  privatePem: string;
  fingerprint: string;
  repoSshUrl: string | null;
  /**
   * Outcome of the auto-register attempt:
   *   - "skipped" — no --repo, --no-gh was passed, or `gh` isn't installed
   *   - "not_authed" — `gh` is installed but `gh auth status` failed
   *   - "registered" — public key successfully POSTed to the repo
   *   - "failed" — gh returned non-zero; `reason` carries the message
   *   - "already_present" — the key was already on the repo (idempotent re-run)
   */
  ghRegistration: GhRegistrationResult;
  text: string;
}

export type GhRegistrationResult =
  | { kind: "skipped" }
  | { kind: "not_authed" }
  | { kind: "registered" }
  | { kind: "already_present" }
  | { kind: "failed"; reason: string };

export interface RegisterGhKeyArgs {
  repo: string;
  publicSshKey: string;
  title: string;
}

/**
 * Default gh-shell-out implementation. Swappable in tests so we can
 * exercise the runDeployKeyCommand orchestration without spawning a
 * real `gh` process.
 */
export function defaultRegisterGhKey(args: RegisterGhKeyArgs): GhRegistrationResult {
  if (!isGhInstalled()) return { kind: "skipped" };
  if (!isGhAuthed()) return { kind: "not_authed" };
  const result = spawnSync(
    "gh",
    [
      "api",
      "-X",
      "POST",
      `repos/${args.repo}/keys`,
      "-f",
      `title=${args.title}`,
      "-f",
      `key=${args.publicSshKey}`,
      "-F",
      "read_only=false",
    ],
    { encoding: "utf8" },
  );
  if (result.status === 0) return { kind: "registered" };
  const stderr = (result.stderr ?? "").toString();
  // GitHub returns 422 with "key is already in use" when the same
  // public key is re-registered. Idempotent re-runs (or a previous
  // partially-completed setup) should look like success.
  if (/key is already in use/i.test(stderr) || /HTTP 422/.test(stderr)) {
    if (/already in use/i.test(stderr)) return { kind: "already_present" };
  }
  return {
    kind: "failed",
    reason:
      stderr
        .split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim() ?? "unknown gh error",
  };
}

function isGhInstalled(): boolean {
  const result = spawnSync("gh", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function isGhAuthed(): boolean {
  const result = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  return result.status === 0;
}

export interface RunDeployKeyCommandOpts {
  /**
   * Override the gh-registration call. Tests pass a stub so we can
   * exercise every branch without spawning a real process. Production
   * uses `defaultRegisterGhKey`.
   */
  registerGhKey?: (args: RegisterGhKeyArgs) => GhRegistrationResult;
}

export function runDeployKeyCommand(
  args: DeployKeyCommandArgs = {},
  opts: RunDeployKeyCommandOpts = {},
): DeployKeyCommandOutput {
  const repoSlug = args.repo?.trim() ?? "";
  const isValidRepoSlug = /^[^/\s]+\/[^/\s]+$/.test(repoSlug);
  if (repoSlug && !isValidRepoSlug) {
    throw new Error(
      `--repo expects "<owner>/<name>" (e.g. render-lab-agents/my-agent-7af3); got "${repoSlug}"`,
    );
  }
  const repoSshUrl = isValidRepoSlug ? `git@github.com:${repoSlug}.git` : null;
  const keypair = generateDeployKeypair(args.comment ?? "render-harness");
  const registerGhKey = opts.registerGhKey ?? defaultRegisterGhKey;

  // Auto-register only when we know the repo + the operator hasn't
  // opted out. Every other case (no --repo, --no-gh, gh missing, gh
  // not authed) collapses to a "skipped" result and the printout
  // includes the manual paste-into-GitHub instructions.
  let ghRegistration: GhRegistrationResult = { kind: "skipped" };
  if (isValidRepoSlug && !args.noGh) {
    ghRegistration = registerGhKey({
      repo: repoSlug,
      publicSshKey: keypair.publicSshKey,
      title: "render-harness-bot",
    });
  }

  const ghKeysUrl = isValidRepoSlug
    ? `https://github.com/${repoSlug}/settings/keys/new`
    : "https://github.com/<owner>/<repo>/settings/keys/new";
  const renderEnvHint = isValidRepoSlug
    ? `git@github.com:${repoSlug}.git`
    : "git@github.com:<owner>/<repo>.git";

  const lines: string[] = [
    "# Render Harness deploy key",
    "",
    `Fingerprint: ${keypair.fingerprint}`,
    "",
  ];

  if (ghRegistration.kind === "registered") {
    lines.push(
      "## 1. Public key registered on GitHub via gh CLI",
      "",
      `Title:    render-harness-bot`,
      `Repo:     ${repoSlug} (write access enabled)`,
      "",
    );
  } else if (ghRegistration.kind === "already_present") {
    lines.push(
      "## 1. Public key already registered on GitHub (re-using existing entry)",
      "",
      `Repo:     ${repoSlug}`,
      "",
      "If this is unexpected, list the repo's deploy keys with `gh api repos/" +
        repoSlug +
        "/keys` and remove stale entries before re-running.",
      "",
    );
  } else {
    // skipped / not_authed / failed — fall through to manual instructions
    lines.push(
      "## 1. Add the public key to GitHub",
      "",
      `Open: ${ghKeysUrl}`,
      "Title:    render-harness-bot",
      'Key:      (paste the block below; check "Allow write access")',
      "",
      keypair.publicSshKey,
      "",
    );
    if (ghRegistration.kind === "not_authed") {
      lines.push(
        "(Tried `gh` CLI to auto-register but you aren't logged in. Run `gh auth login` and re-run this command to skip the manual paste.)",
        "",
      );
    } else if (ghRegistration.kind === "failed") {
      lines.push(
        `(Tried \`gh\` CLI to auto-register but it returned: ${ghRegistration.reason}. Add the key manually below, or fix the gh error and re-run.)`,
        "",
      );
    } else if (isValidRepoSlug && args.noGh) {
      lines.push(
        "(--no-gh was passed; skipped the gh-CLI auto-register attempt. Remove --no-gh and re-run to register automatically if `gh` is installed and authed.)",
        "",
      );
    } else if (isValidRepoSlug) {
      // `gh` not installed
      lines.push(
        "(Install the `gh` CLI and run `gh auth login` to skip the manual paste on future runs.)",
        "",
      );
    }
  }

  lines.push(
    "## 2. Add the private key + repo URL to your Render service env",
    "",
    "Dashboard -> your web service -> Environment -> Add Environment Variable",
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
    "- Edit-in-UI (Install capability, Add agent, Edit model) only works when both env vars are set on the deployed service AND the public key has write access on the repo.",
    '- If the operator UI says "edit_in_ui_not_configured", check that both env vars are set and the service has restarted since you added them.',
    "- This is a one-time setup per harness. To rotate the key later, generate a new pair, replace the GitHub deploy key (remove the old one), and update GITHUB_DEPLOY_KEY in Render env.",
    "- The private key was generated in-memory and never written to disk; copy it now or rerun this command to generate a fresh one.",
  );

  return {
    publicSshKey: keypair.publicSshKey,
    privatePem: keypair.privatePem,
    fingerprint: keypair.fingerprint,
    repoSshUrl,
    ghRegistration,
    text: lines.join("\n"),
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
    } else if (token === "--no-gh") {
      args.noGh = true;
    } else if (token && token !== "deploy-key") {
      throw new Error(`unknown deploy-key flag: ${token}`);
    }
  }
  return args;
}
