import { describe, expect, it, vi } from "vitest";
import {
  type GhRegistrationResult,
  parseDeployKeyArgs,
  runDeployKeyCommand,
} from "./deploy-key-cmd.js";

/**
 * Stub gh-shell-out factory. Default returns `{ kind: "skipped" }` so
 * tests don't invoke a real `gh` process — every test that wants a
 * specific path passes its own stub explicitly.
 */
function stubGh(result: GhRegistrationResult = { kind: "skipped" }) {
  return vi.fn(() => result);
}

describe("parseDeployKeyArgs", () => {
  it("returns empty args for no flags", () => {
    expect(parseDeployKeyArgs([])).toEqual({});
    expect(parseDeployKeyArgs(["deploy-key"])).toEqual({});
  });

  it("parses --repo with space-separated value", () => {
    expect(parseDeployKeyArgs(["--repo", "render-lab-agents/my-agent-7af3"])).toEqual({
      repo: "render-lab-agents/my-agent-7af3",
    });
  });

  it("parses --repo=value form", () => {
    expect(parseDeployKeyArgs(["--repo=render-lab-agents/my-agent-7af3"])).toEqual({
      repo: "render-lab-agents/my-agent-7af3",
    });
  });

  it("parses --comment", () => {
    expect(parseDeployKeyArgs(["--comment", "alice@laptop"])).toEqual({
      comment: "alice@laptop",
    });
  });

  it("parses --no-gh as a boolean flag", () => {
    expect(parseDeployKeyArgs(["--no-gh"])).toEqual({ noGh: true });
    expect(parseDeployKeyArgs(["--repo", "render-lab-agents/foo-bar", "--no-gh"])).toEqual({
      repo: "render-lab-agents/foo-bar",
      noGh: true,
    });
  });

  it("rejects unknown flags", () => {
    expect(() => parseDeployKeyArgs(["--badflag"])).toThrow(/unknown deploy-key flag/);
  });

  it("rejects --repo without a value", () => {
    expect(() => parseDeployKeyArgs(["--repo"])).toThrow(/--repo requires a value/);
  });
});

describe("runDeployKeyCommand", () => {
  it("prints a public ssh-ed25519 key, an OpenSSH PEM, and a fingerprint", () => {
    const out = runDeployKeyCommand({}, { registerGhKey: stubGh() });
    expect(out.publicSshKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(out.privatePem.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(out.fingerprint.startsWith("SHA256:")).toBe(true);
    expect(out.repoSshUrl).toBeNull();
  });

  it("includes the github-keys URL and both paste-here labels in the printout", () => {
    const out = runDeployKeyCommand({}, { registerGhKey: stubGh() });
    expect(out.text).toContain("https://github.com/<owner>/<repo>/settings/keys/new");
    expect(out.text).toContain("GITHUB_DEPLOY_KEY");
    expect(out.text).toContain("GITHUB_DEPLOY_REPO_SSH_URL");
    expect(out.text).toContain(out.publicSshKey);
    expect(out.text).toContain(out.privatePem.trimEnd());
    expect(out.text).toContain(out.fingerprint);
  });

  it("pre-fills the GitHub URL and the repo SSH URL when --repo is supplied", () => {
    const out = runDeployKeyCommand(
      { repo: "render-lab-agents/foo-bar" },
      { registerGhKey: stubGh() },
    );
    expect(out.repoSshUrl).toBe("git@github.com:render-lab-agents/foo-bar.git");
    expect(out.text).toContain("https://github.com/render-lab-agents/foo-bar/settings/keys/new");
    expect(out.text).toContain("git@github.com:render-lab-agents/foo-bar.git");
  });

  it("rejects --repo without the owner/name shape", () => {
    expect(() =>
      runDeployKeyCommand({ repo: "no-slash-here" }, { registerGhKey: stubGh() }),
    ).toThrow(/owner.*name/);
    expect(() =>
      runDeployKeyCommand({ repo: "too/many/slashes" }, { registerGhKey: stubGh() }),
    ).toThrow(/owner.*name/);
  });

  it("respects --comment", () => {
    const out = runDeployKeyCommand({ comment: "prod-key-2026" }, { registerGhKey: stubGh() });
    expect(out.publicSshKey.endsWith(" prod-key-2026")).toBe(true);
  });

  it("does NOT invoke gh when --repo is missing (nothing to auto-register on)", () => {
    const registerGhKey = stubGh();
    runDeployKeyCommand({}, { registerGhKey });
    expect(registerGhKey).not.toHaveBeenCalled();
  });

  it("does NOT invoke gh when --no-gh is set, even with --repo", () => {
    const registerGhKey = stubGh();
    const out = runDeployKeyCommand(
      { repo: "render-lab-agents/foo-bar", noGh: true },
      { registerGhKey },
    );
    expect(registerGhKey).not.toHaveBeenCalled();
    expect(out.ghRegistration).toEqual({ kind: "skipped" });
    // Manual instructions still printed.
    expect(out.text).toContain("## 1. Add the public key to GitHub");
    expect(out.text).toContain("--no-gh was passed");
  });

  it("invokes gh with the right repo + title when --repo is set and --no-gh is not", () => {
    const registerGhKey = stubGh({ kind: "registered" });
    const out = runDeployKeyCommand({ repo: "render-lab-agents/foo-bar" }, { registerGhKey });
    expect(registerGhKey).toHaveBeenCalledTimes(1);
    expect(registerGhKey).toHaveBeenCalledWith({
      repo: "render-lab-agents/foo-bar",
      publicSshKey: out.publicSshKey,
      title: "render-harness-bot",
    });
  });

  it("on gh success: replaces the manual paste section with a confirmation line", () => {
    const out = runDeployKeyCommand(
      { repo: "render-lab-agents/foo-bar" },
      { registerGhKey: stubGh({ kind: "registered" }) },
    );
    expect(out.ghRegistration).toEqual({ kind: "registered" });
    expect(out.text).toContain("## 1. Public key registered on GitHub via gh CLI");
    expect(out.text).toContain("render-lab-agents/foo-bar (write access enabled)");
    // No "Add the public key to GitHub" manual block.
    expect(out.text).not.toContain("## 1. Add the public key to GitHub");
    // Private-half block is unconditionally present.
    expect(out.text).toContain("Key:   GITHUB_DEPLOY_KEY");
    expect(out.text).toContain(out.privatePem.trimEnd());
  });

  it("on gh already_present: surfaces the idempotent re-run state", () => {
    const out = runDeployKeyCommand(
      { repo: "render-lab-agents/foo-bar" },
      { registerGhKey: stubGh({ kind: "already_present" }) },
    );
    expect(out.ghRegistration).toEqual({ kind: "already_present" });
    expect(out.text).toContain("Public key already registered on GitHub");
    expect(out.text).toContain("gh api repos/render-lab-agents/foo-bar/keys");
    expect(out.text).not.toContain("## 1. Add the public key to GitHub");
  });

  it("on gh not_authed: falls back to manual paste with a hint to `gh auth login`", () => {
    const out = runDeployKeyCommand(
      { repo: "render-lab-agents/foo-bar" },
      { registerGhKey: stubGh({ kind: "not_authed" }) },
    );
    expect(out.ghRegistration).toEqual({ kind: "not_authed" });
    expect(out.text).toContain("## 1. Add the public key to GitHub");
    expect(out.text).toContain("gh auth login");
  });

  it("on gh failed: falls back to manual paste and surfaces the gh error reason", () => {
    const out = runDeployKeyCommand(
      { repo: "render-lab-agents/foo-bar" },
      { registerGhKey: stubGh({ kind: "failed", reason: "HTTP 404: Not Found" }) },
    );
    expect(out.ghRegistration).toEqual({ kind: "failed", reason: "HTTP 404: Not Found" });
    expect(out.text).toContain("## 1. Add the public key to GitHub");
    expect(out.text).toContain("HTTP 404: Not Found");
  });

  it("when --repo is set but gh isn't installed (skipped result), prints the install hint", () => {
    const out = runDeployKeyCommand(
      { repo: "render-lab-agents/foo-bar" },
      { registerGhKey: stubGh({ kind: "skipped" }) },
    );
    expect(out.text).toContain("## 1. Add the public key to GitHub");
    expect(out.text).toContain("Install the `gh` CLI");
  });
});
