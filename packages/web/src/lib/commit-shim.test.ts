import type { DeploymentInfo } from "@render-harness/contracts";
import { describe, expect, it } from "vitest";
import { pickCommitPath } from "./commit-shim.js";

const DEPLOYMENT: DeploymentInfo = {
  name: "test",
  description: "",
  agents: [],
  repoLocator: {
    org: "render-lab-agents",
    repo: "my-agent-aaaa",
    installationId: "1",
    repoSshUrl: "git@github.com:render-lab-agents/my-agent-aaaa.git",
  },
};

describe("pickCommitPath", () => {
  it("returns deploy_key when both GITHUB_DEPLOY_KEY and repoSshUrl are present", () => {
    const path = pickCommitPath({
      deployment: DEPLOYMENT,
      wizardSharedSecret: "legacy",
      env: { GITHUB_DEPLOY_KEY: "PEM" },
    });
    expect(path.kind).toBe("deploy_key");
    if (path.kind === "deploy_key") {
      expect(path.repoSshUrl).toBe("git@github.com:render-lab-agents/my-agent-aaaa.git");
      expect(path.deployKeyPem).toBe("PEM");
    }
  });

  it("prefers deploy_key over wizard_proxy when both could work", () => {
    const path = pickCommitPath({
      deployment: DEPLOYMENT,
      wizardSharedSecret: "legacy",
      env: { GITHUB_DEPLOY_KEY: "PEM" },
    });
    expect(path.kind).toBe("deploy_key");
  });

  it("falls back to GITHUB_DEPLOY_REPO_SSH_URL env when deployment locator lacks repoSshUrl", () => {
    const dep: DeploymentInfo = {
      ...DEPLOYMENT,
      repoLocator: { org: "x", repo: "y", installationId: "1" },
    };
    const path = pickCommitPath({
      deployment: dep,
      wizardSharedSecret: null,
      env: { GITHUB_DEPLOY_KEY: "PEM", GITHUB_DEPLOY_REPO_SSH_URL: "git@host:x/y.git" },
    });
    expect(path.kind).toBe("deploy_key");
    if (path.kind === "deploy_key") expect(path.repoSshUrl).toBe("git@host:x/y.git");
  });

  it("returns wizard_proxy when only WIZARD_SHARED_SECRET is set", () => {
    const path = pickCommitPath({
      deployment: DEPLOYMENT,
      wizardSharedSecret: "legacy",
      env: {},
    });
    expect(path.kind).toBe("wizard_proxy");
  });

  it("returns unconfigured when neither path is available", () => {
    const path = pickCommitPath({
      deployment: DEPLOYMENT,
      wizardSharedSecret: null,
      env: {},
    });
    expect(path.kind).toBe("unconfigured");
    if (path.kind === "unconfigured") {
      expect(path.reason).toContain("GITHUB_DEPLOY_KEY");
      expect(path.reason).toContain("WIZARD_SHARED_SECRET");
    }
  });

  it("returns unconfigured when GITHUB_DEPLOY_KEY is set but no repo SSH URL", () => {
    const dep: DeploymentInfo = {
      ...DEPLOYMENT,
      repoLocator: { org: null, repo: null, installationId: null },
    };
    const path = pickCommitPath({
      deployment: dep,
      wizardSharedSecret: null,
      env: { GITHUB_DEPLOY_KEY: "PEM" },
    });
    expect(path.kind).toBe("unconfigured");
  });
});
