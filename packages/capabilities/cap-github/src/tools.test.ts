import { describe, expect, it } from "vitest";
import pack from "./index.js";
import { githubTools } from "./tools.js";

describe("githubTools", () => {
  it("registers only read tools by default", () => {
    const names = githubTools({ token: "token", accessMode: "read" }).map(
      (tool) => tool.definition.name,
    );
    expect(names).toContain("github.get_issue");
    expect(names).toContain("github.list_issue_comments");
    expect(names).toContain("github.list_workflow_run_jobs");
    expect(names).not.toContain("github.create_issue_comment");
    expect(names).not.toContain("github.update_issue");
  });

  it("registers write tools in read_write mode", () => {
    const names = githubTools({ token: "token", accessMode: "read_write" }).map(
      (tool) => tool.definition.name,
    );
    expect(names).toContain("github.create_issue_comment");
    expect(names).toContain("github.create_pull_request_review_comment");
    expect(names).toContain("github.update_issue");
    expect(names).toContain("github.rerun_workflow_run");
  });
});

describe("cap-github pack", () => {
  it("skips local tools when GITHUB_TOKEN is missing", async () => {
    const tools = await pack.localTools?.({
      config: {},
      env: () => undefined,
      entryName: "test",
    });
    expect(tools).toEqual([]);
  });
});
