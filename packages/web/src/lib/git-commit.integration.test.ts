/**
 * Local-bare-repo integration tests for git-commit.ts. We swap the
 * `repoSshUrl` for a `file://` URL pointing at a tmpdir bare repo, so
 * the test exercises the real simple-git clone+commit+push round-trip
 * without needing SSH credentials or network access. SSH is covered
 * separately by the manual smoke check in plan §11.
 *
 * Skipped automatically if the system `git` binary is missing — the
 * stderr message is verbose so CI failures are actionable.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitFilesToRepo, withRepoClone } from "./git-commit.js";

const SKIP_REASON = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return null;
  } catch {
    return "git binary not on PATH — install git to run these integration tests";
  }
})();

if (SKIP_REASON) {
  describe.skip(`git-commit integration (${SKIP_REASON})`, () => {});
} else {
  describe("git-commit integration", () => {
    let workspace: string;
    let bareRepoUrl: string;

    beforeAll(() => {
      workspace = mkdtempSync(join(tmpdir(), "render-harness-test-"));
      const bareDir = join(workspace, "remote.git");
      mkdirSync(bareDir, { recursive: true });
      execSync("git init --bare --initial-branch=main", { cwd: bareDir });

      // Seed the bare repo by cloning, committing the initial files, pushing.
      const seedDir = join(workspace, "seed");
      mkdirSync(seedDir, { recursive: true });
      execSync(`git clone ${bareDir} ${seedDir}`, { stdio: "ignore" });
      writeFileSync(join(seedDir, "README.md"), "# initial\n");
      writeFileSync(join(seedDir, "render-harness.yaml"), "agents: []\n");
      execSync("git -c user.email=t@t -c user.name=t add -A", { cwd: seedDir });
      execSync('git -c user.email=t@t -c user.name=t commit -m "seed"', { cwd: seedDir });
      execSync("git push origin HEAD:main", { cwd: seedDir });
      bareRepoUrl = `file://${bareDir}`;
    });

    afterAll(() => {
      rmSync(workspace, { recursive: true, force: true });
    });

    it("commits and pushes a new file via withRepoClone", async () => {
      const { commit, result } = await withRepoClone(
        {
          repoSshUrl: bareRepoUrl,
          // file:// URLs don't use SSH; the PEM is unused but the
          // helper still writes it to disk so we pass a placeholder.
          deployKeyPem: "stub-pem",
          tmpdirBase: workspace,
        },
        async (ctx) => {
          await ctx.writeFile("docs/new.md", "hello\n");
          return { message: "chore: add new file", result: "ok" };
        },
      );
      expect(commit.commitSha).not.toBeNull();
      expect(commit.changedFiles).toContain("docs/new.md");
      expect(result).toBe("ok");
    });

    it("skips the commit when nothing changed", async () => {
      const noopCommit = await commitFilesToRepo({
        repoSshUrl: bareRepoUrl,
        deployKeyPem: "stub-pem",
        tmpdirBase: workspace,
        files: new Map([["README.md", "# initial\n"]]),
        message: "chore: noop",
      });
      expect(noopCommit.commitSha).toBeNull();
      expect(noopCommit.changedFiles).toEqual([]);
    });

    it("commits only files whose contents actually change", async () => {
      const result = await commitFilesToRepo({
        repoSshUrl: bareRepoUrl,
        deployKeyPem: "stub-pem",
        tmpdirBase: workspace,
        files: new Map([
          // README is identical to seed — should NOT be in changedFiles.
          ["README.md", "# initial\n"],
          // render-harness.yaml has different content — should commit.
          ["render-harness.yaml", "agents:\n  - id: new-one\n"],
        ]),
        message: "chore: bump manifest",
      });
      expect(result.commitSha).not.toBeNull();
      expect(result.changedFiles).toEqual(["render-harness.yaml"]);
    });

    it("cleans up worktree and key tmp dirs after success", async () => {
      const before = readdirSync(workspace);
      await commitFilesToRepo({
        repoSshUrl: bareRepoUrl,
        deployKeyPem: "stub-pem",
        tmpdirBase: workspace,
        files: new Map([["cleanup-check.txt", "ok\n"]]),
        message: "chore: cleanup probe",
      });
      const after = readdirSync(workspace);
      // The seed + remote dirs persist; any harness-* tmpdirs should be gone.
      const harnessDirs = after.filter((name) => name.startsWith("render-harness-"));
      expect(harnessDirs).toEqual([]);
      expect(after.filter((name) => !name.startsWith("render-harness-"))).toEqual(before);
    });

    it("cleans up tmp dirs even when the callback throws", async () => {
      const before = readdirSync(workspace);
      await expect(
        withRepoClone(
          {
            repoSshUrl: bareRepoUrl,
            deployKeyPem: "stub-pem",
            tmpdirBase: workspace,
          },
          async () => {
            throw new Error("boom");
          },
        ),
      ).rejects.toThrow("boom");
      const after = readdirSync(workspace);
      const harnessDirs = after.filter((name) => name.startsWith("render-harness-"));
      expect(harnessDirs).toEqual([]);
      expect(after.filter((name) => !name.startsWith("render-harness-"))).toEqual(before);
    });

    it("refuses paths that escape the worktree", async () => {
      await expect(
        withRepoClone(
          {
            repoSshUrl: bareRepoUrl,
            deployKeyPem: "stub-pem",
            tmpdirBase: workspace,
          },
          async (ctx) => {
            await ctx.writeFile("../escape.txt", "nope");
            return { message: "should never get here" };
          },
        ),
      ).rejects.toThrow(/escapes worktree/);
    });
  });
}
