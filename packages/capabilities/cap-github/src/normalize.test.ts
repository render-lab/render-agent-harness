import { describe, expect, it } from "vitest";
import { normalizeGitHubEvent } from "./normalize.js";

describe("normalizeGitHubEvent", () => {
  it("normalizes pull_request events", () => {
    const event = normalizeGitHubEvent("pull_request", {
      action: "opened",
      repository: { full_name: "render/render-harness" },
      sender: { login: "raph" },
      pull_request: {
        number: 12,
        html_url: "https://github.com/render/render-harness/pull/12",
        head: { ref: "feature" },
      },
    });
    expect(event).toMatchObject({
      event: "pull_request",
      action: "opened",
      repo: "render/render-harness",
      actor: "raph",
      objectType: "pull_request",
      number: 12,
      branch: "feature",
    });
  });

  it("filters repositories and branches", () => {
    const payload = {
      repository: { full_name: "render/render-harness" },
      ref: "refs/heads/feature",
      sender: { login: "raph" },
      after: "abc",
    };
    expect(
      normalizeGitHubEvent("push", payload, {
        allowedRepositories: ["render/render-harness"],
        branches: ["main"],
      }),
    ).toBeNull();
  });

  it("returns null for unsupported events", () => {
    expect(normalizeGitHubEvent("star", {})).toBeNull();
  });
});
