import { describe, expect, it } from "vitest";
import { parseDeployKeyArgs, runDeployKeyCommand } from "./deploy-key-cmd.js";

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

  it("rejects unknown flags", () => {
    expect(() => parseDeployKeyArgs(["--badflag"])).toThrow(/unknown deploy-key flag/);
  });

  it("rejects --repo without a value", () => {
    expect(() => parseDeployKeyArgs(["--repo"])).toThrow(/--repo requires a value/);
  });
});

describe("runDeployKeyCommand", () => {
  it("prints a public ssh-ed25519 key, an OpenSSH PEM, and a fingerprint", () => {
    const out = runDeployKeyCommand();
    expect(out.publicSshKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(out.privatePem.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(out.fingerprint.startsWith("SHA256:")).toBe(true);
    expect(out.repoSshUrl).toBeNull();
  });

  it("includes the github-keys URL and both paste-here labels in the printout", () => {
    const out = runDeployKeyCommand();
    expect(out.text).toContain("https://github.com/<owner>/<repo>/settings/keys/new");
    expect(out.text).toContain("GITHUB_DEPLOY_KEY");
    expect(out.text).toContain("GITHUB_DEPLOY_REPO_SSH_URL");
    expect(out.text).toContain(out.publicSshKey);
    expect(out.text).toContain(out.privatePem.trimEnd());
    expect(out.text).toContain(out.fingerprint);
  });

  it("pre-fills the GitHub URL and the repo SSH URL when --repo is supplied", () => {
    const out = runDeployKeyCommand({ repo: "render-lab-agents/foo-bar" });
    expect(out.repoSshUrl).toBe("git@github.com:render-lab-agents/foo-bar.git");
    expect(out.text).toContain("https://github.com/render-lab-agents/foo-bar/settings/keys/new");
    expect(out.text).toContain("git@github.com:render-lab-agents/foo-bar.git");
  });

  it("rejects --repo without the owner/name shape", () => {
    expect(() => runDeployKeyCommand({ repo: "no-slash-here" })).toThrow(/owner.*name/);
    expect(() => runDeployKeyCommand({ repo: "too/many/slashes" })).toThrow(/owner.*name/);
  });

  it("respects --comment", () => {
    const out = runDeployKeyCommand({ comment: "prod-key-2026" });
    expect(out.publicSshKey.endsWith(" prod-key-2026")).toBe(true);
  });
});
