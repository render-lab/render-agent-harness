/**
 * Per-harness SSH git commit helpers. Powers the post-WIZARD_SHARED_SECRET
 * deploy-key path for edit-in-UI: the harness clones its own managed
 * repo with its repo-scoped SSH key, runs the same pure mutations the
 * wizard used to run server-side, and pushes the result back without
 * proxying through the wizard.
 *
 * Two layers:
 *
 *   1. {@link withRepoClone} — shallow-clones the repo into a tmp dir,
 *      runs the caller's callback against the worktree, and unconditionally
 *      cleans up. Used when the route needs to both read current files
 *      and write a commit (plan-then-mutate flow).
 *   2. {@link commitFilesToRepo} — thin wrapper around `withRepoClone`
 *      for the common case where the caller already has the full file
 *      contents to write and just wants them committed + pushed.
 *
 * Both isolate the private-key handling: the PEM is written to an
 * 0o600 file in a fresh tmp dir per call, `GIT_SSH_COMMAND` points at
 * it, and the tmp dir is removed in a `finally` block. The PEM never
 * touches the worktree.
 *
 * Requires the `git` binary on PATH at runtime (Render's default Node
 * runtime image includes it; verified in §11 of the deploy-key plan).
 */

import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";

/**
 * Verified at module load — Render's native Node runtime includes
 * `git` per https://render.com/docs/native-runtimes, so this is just
 * defensive cover for hand-rolled deployments. We probe once and
 * memoize so the cost is paid at boot, not on every commit.
 */
let gitBinaryProbed = false;
let gitBinaryAvailable: boolean | null = null;

function ensureGitAvailable(): void {
  if (gitBinaryProbed) {
    if (gitBinaryAvailable === false) {
      throw new Error(
        "git binary not on PATH — required for the GITHUB_DEPLOY_KEY commit flow. " +
          "Install git in your runtime image, or unset GITHUB_DEPLOY_KEY and fall back to WIZARD_SHARED_SECRET.",
      );
    }
    return;
  }
  gitBinaryProbed = true;
  try {
    execSync("git --version", { stdio: "ignore" });
    gitBinaryAvailable = true;
  } catch {
    gitBinaryAvailable = false;
    throw new Error(
      "git binary not on PATH — required for the GITHUB_DEPLOY_KEY commit flow. " +
        "Install git in your runtime image, or unset GITHUB_DEPLOY_KEY and fall back to WIZARD_SHARED_SECRET.",
    );
  }
}

export interface RepoCloneCtx {
  /** Absolute path to the cloned worktree. */
  worktreePath: string;
  /** The branch that was checked out (defaults to the remote HEAD). */
  branch: string;
  /** Read a file from the worktree, returning null if it doesn't exist. */
  readFile(relativePath: string): Promise<string | null>;
  /** Write (or overwrite) a file in the worktree. Creates parent dirs. */
  writeFile(relativePath: string, contents: string): Promise<void>;
  /** Low-level git client bound to the cloned worktree. */
  git: SimpleGit;
}

export interface CommitResult {
  /** Commit SHA produced, or null if no files actually changed. */
  commitSha: string | null;
  /** Repo-relative paths the caller asked to write that actually changed. */
  changedFiles: string[];
}

export interface WithRepoCloneOpts {
  /** SSH URL, e.g. `git@github.com:render-lab-agents/my-agent-7af3.git`. */
  repoSshUrl: string;
  /** OpenSSH-format private key PEM (the value of `GITHUB_DEPLOY_KEY`). */
  deployKeyPem: string;
  /** Branch to clone + push to. Defaults to `main`. */
  branch?: string;
  /**
   * Skip the actual `git push` after the commit (useful for dry-run
   * tests). When `true`, `commitSha` still reflects the local commit
   * but nothing leaves the worktree.
   */
  noPush?: boolean;
  /** Author/committer identity for any commit the callback makes. */
  author?: { name?: string; email?: string };
  /**
   * Optional override of `os.tmpdir()` for tests. Lets us point at a
   * controlled directory whose cleanup we can assert.
   */
  tmpdirBase?: string;
}

export interface CommitFilesToRepoOpts extends WithRepoCloneOpts {
  /**
   * Files to write, keyed by repo-relative path. The wrapper reads any
   * existing version first to skip writes that wouldn't change content.
   */
  files: Map<string, string>;
  /** Commit message body. */
  message: string;
}

const DEFAULT_BRANCH = "main";
const DEFAULT_AUTHOR = {
  name: "render-harness[bot]",
  email: "bot@render-agent-harness.local",
};

/**
 * Shallow-clone the repo, hand the caller a worktree-bound context,
 * commit + push whatever they wrote, and always clean up.
 */
export async function withRepoClone<T>(
  opts: WithRepoCloneOpts,
  callback: (ctx: RepoCloneCtx) => Promise<{ message: string; result?: T } | null>,
): Promise<{ commit: CommitResult; result: T | null }> {
  ensureGitAvailable();
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const keyDir = mkdtempSync(join(opts.tmpdirBase ?? tmpdir(), "render-harness-key-"));
  const worktreeDir = mkdtempSync(join(opts.tmpdirBase ?? tmpdir(), "render-harness-clone-"));
  const keyPath = join(keyDir, "id_ed25519");
  try {
    writeFileSync(keyPath, ensureTrailingNewline(opts.deployKeyPem), { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    // Strict-host-checking off + an empty UserKnownHostsFile keeps this
    // hermetic: we don't trust any host beyond what the deploy key
    // implicitly anchors us to, and we don't pollute the runtime image's
    // known_hosts. We pass GIT_SSH_COMMAND via env rather than
    // `core.sshCommand` because git refuses to honour the latter without
    // `allowUnsafeSshCommand` (https://git-scm.com/docs/git-config).
    const sshCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -F /dev/null`;
    // Pass a minimal env to git (PATH + HOME + GIT_SSH_COMMAND). We
    // skip forwarding the parent process's full env because simple-git
    // refuses to pass certain "unsafe" parent vars (PAGER, LESS,
    // GIT_PROXY_COMMAND, etc.) without explicit opt-in, and we don't
    // need any of them here.
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_SSH_COMMAND: sshCmd,
      GIT_TERMINAL_PROMPT: "0",
    };
    // simple-git's vulnerability-scanner plugin (via @simple-git/argv-parser)
    // blocks `GIT_SSH_COMMAND` in env() by default. We opt in via
    // `unsafe.allowUnsafeSshCommand` because we control both the SSH
    // binary we invoke and the key file it reads — the env var is the
    // only way to pin git's transport to our per-harness deploy key
    // without a system-wide ssh config. Also opt into
    // `allowUnsafeProtocolOverride` so `file://` URLs work in
    // integration tests; in production `repoSshUrl` is `git@github.com:…`.
    const gitOpts = {
      baseDir: worktreeDir,
      unsafe: {
        allowUnsafeSshCommand: true,
        allowUnsafeProtocolOverride: true,
      },
    } as const;
    const baseGit = simpleGit(gitOpts);
    baseGit.env(childEnv);
    await baseGit.clone(opts.repoSshUrl, worktreeDir, ["--depth", "1", "--branch", branch]);

    const git = simpleGit(gitOpts);
    git.env(childEnv);
    const author = { ...DEFAULT_AUTHOR, ...(opts.author ?? {}) };
    await git.addConfig("user.name", author.name);
    await git.addConfig("user.email", author.email);

    const ctx: RepoCloneCtx = {
      worktreePath: worktreeDir,
      branch,
      git,
      readFile: async (rel) => {
        const absolute = resolveInside(worktreeDir, rel);
        try {
          return await readFile(absolute, "utf8");
        } catch (err) {
          if (isNodeNotFound(err)) return null;
          throw err;
        }
      },
      writeFile: async (rel, contents) => {
        const absolute = resolveInside(worktreeDir, rel);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, contents, "utf8");
      },
    };

    const callbackResult = await callback(ctx);
    if (callbackResult === null) {
      return { commit: { commitSha: null, changedFiles: [] }, result: null };
    }

    // Stage everything the callback wrote / modified.
    await git.add(".");
    const status = await git.status();
    const changedFiles = [
      ...status.not_added,
      ...status.created,
      ...status.modified,
      ...status.deleted,
      ...status.renamed.map((r) => r.to),
    ];
    if (changedFiles.length === 0) {
      return {
        commit: { commitSha: null, changedFiles: [] },
        result: callbackResult.result ?? null,
      };
    }
    const commit = await git.commit(callbackResult.message);
    if (!opts.noPush) {
      await git.push("origin", `HEAD:${branch}`);
    }
    return {
      commit: { commitSha: commit.commit, changedFiles },
      result: callbackResult.result ?? null,
    };
  } finally {
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      rmSync(keyDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Convenience wrapper for callers that already have the final file
 * contents to write. Reads each path first so unchanged writes don't
 * cost a commit.
 */
export async function commitFilesToRepo(opts: CommitFilesToRepoOpts): Promise<CommitResult> {
  const { files, message, ...cloneOpts } = opts;
  const { commit } = await withRepoClone(cloneOpts, async (ctx) => {
    let anyChange = false;
    for (const [rel, next] of files) {
      const current = await ctx.readFile(rel);
      if (current === next) continue;
      await ctx.writeFile(rel, next);
      anyChange = true;
    }
    if (!anyChange) return null;
    return { message };
  });
  return commit;
}

function resolveInside(root: string, rel: string): string {
  const resolved = resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`refusing to access ${rel}: escapes worktree`);
  }
  return resolved;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isNodeNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
