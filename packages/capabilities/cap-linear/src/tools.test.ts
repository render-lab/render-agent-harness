import { describe, expect, it } from "vitest";
import { linearTools } from "./tools.js";

describe("linearTools", () => {
  it("registers only read tools by default", () => {
    const names = linearTools({ apiKey: "key", accessMode: "read" }).map(
      (tool) => tool.definition.name,
    );
    expect(names).toContain("linear.get_issue");
    expect(names).toContain("linear.list_teams");
    expect(names).toContain("linear.list_projects");
    expect(names).not.toContain("linear.create_comment");
    expect(names).not.toContain("linear.create_issue");
  });

  it("registers write tools in read_write mode", () => {
    const names = linearTools({ apiKey: "key", accessMode: "read_write" }).map(
      (tool) => tool.definition.name,
    );
    expect(names).toContain("linear.create_issue");
    expect(names).toContain("linear.update_issue");
    expect(names).toContain("linear.assign_issue");
    expect(names).toContain("linear.link_related_issue");
  });
});
