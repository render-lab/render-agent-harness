import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { buildDeployUrl, createScaffoldedRepo } from "./github-app.js";

describe("createScaffoldedRepo", () => {
  it("seeds empty repositories through the Contents API", async () => {
    const createInOrg = vi.fn(async () => ({
      data: { html_url: "https://github.com/render-lab/RAH-my-agent-abcd" },
    }));
    const createOrUpdateFileContents = vi.fn(async ({ path }: { path: string }) => ({
      data: { commit: { sha: `sha-${path}` } },
    }));
    const octokit = {
      repos: { createInOrg, createOrUpdateFileContents },
    } as unknown as Octokit;

    const result = await createScaffoldedRepo({
      octokit,
      org: "render-lab",
      desiredName: "RAH-my-agent",
      description: "Test agent",
      files: new Map([
        ["package.json", "{}\n"],
        ["src/main.ts", "export {};\n"],
      ]),
      beforeCommit: ({ repoName }) => new Map([[".render-harness/agent.json", `${repoName}\n`]]),
    });

    expect(createInOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        org: "render-lab",
        name: expect.stringMatching(/^RAH-my-agent-[0-9a-f]{4}$/),
        private: true,
        auto_init: false,
      }),
    );
    expect(createOrUpdateFileContents).toHaveBeenCalledTimes(3);
    expect(createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "render-lab",
        path: "package.json",
        content: Buffer.from("{}\n", "utf8").toString("base64"),
      }),
    );
    expect(result.repoUrl).toBe("https://github.com/render-lab/RAH-my-agent-abcd");
    expect(result.commitSha).toBe("sha-.render-harness/agent.json");
  });
});

describe("buildDeployUrl", () => {
  it("constructs the Render Blueprint deploy URL", () => {
    const url = buildDeployUrl("https://github.com/render-lab-agents/my-agent-7af3");
    expect(url).toBe(
      "https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Frender-lab-agents%2Fmy-agent-7af3",
    );
  });

  it("URL-encodes special characters in the repo path", () => {
    const url = buildDeployUrl("https://github.com/org/repo+with+plus");
    expect(url).toContain("repo%2Bwith%2Bplus");
  });
});
