import { describe, expect, it } from "vitest";
import { buildDeployUrl } from "./github-app.js";

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
