import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { generateDeployKeypair, registerDeployKey } from "./deploy-keys.js";

describe("deploy-keys re-export", () => {
  it("re-exports generateDeployKeypair from the registry", () => {
    const { publicSshKey, privatePem, fingerprint } = generateDeployKeypair("wizard-test");
    expect(publicSshKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(publicSshKey.endsWith(" wizard-test")).toBe(true);
    expect(privatePem.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(fingerprint.startsWith("SHA256:")).toBe(true);
  });
});

describe("registerDeployKey", () => {
  it("calls octokit.repos.createDeployKey with write access by default", async () => {
    const createDeployKey = vi.fn(async () => ({
      data: { id: 12345, verified: true },
    }));
    const octokit = {
      repos: { createDeployKey },
    } as unknown as Octokit;

    const result = await registerDeployKey({
      octokit,
      org: "render-lab-agents",
      repo: "my-agent-1234",
      publicSshKey: "ssh-ed25519 AAAA... bot@render",
      title: "render-harness-bot",
    });

    expect(createDeployKey).toHaveBeenCalledTimes(1);
    expect(createDeployKey).toHaveBeenCalledWith({
      owner: "render-lab-agents",
      repo: "my-agent-1234",
      title: "render-harness-bot",
      key: "ssh-ed25519 AAAA... bot@render",
      read_only: false,
    });
    expect(result).toEqual({ id: 12345, verified: true });
  });

  it("honours readOnly: true when requested", async () => {
    const createDeployKey = vi.fn(async () => ({
      data: { id: 999, verified: false },
    }));
    const octokit = {
      repos: { createDeployKey },
    } as unknown as Octokit;

    await registerDeployKey({
      octokit,
      org: "render-lab-agents",
      repo: "diagnostics-repo",
      publicSshKey: "ssh-ed25519 AAAA... ro",
      title: "render-harness-ro",
      readOnly: true,
    });

    expect(createDeployKey).toHaveBeenCalledWith(expect.objectContaining({ read_only: true }));
  });
});
