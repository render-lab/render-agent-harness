import { describe, expect, it } from "vitest";
import { parseSkill } from "./skills.js";

describe("parseSkill", () => {
  it("parses YAML-style frontmatter", () => {
    const raw = [
      "---",
      "name: deploy",
      "description: Deploys a repo to Render",
      "when_to_use: When the user asks to deploy a repo",
      "---",
      "",
      "# Body",
      "",
      "Detailed instructions go here.",
    ].join("\n");
    const parsed = parseSkill(raw, "/skills/deploy/SKILL.md");
    expect(parsed).not.toBeNull();
    expect(parsed?.metadata.name).toBe("deploy");
    expect(parsed?.metadata.description).toBe("Deploys a repo to Render");
    expect(parsed?.metadata.whenToUse).toBe("When the user asks to deploy a repo");
    expect(parsed?.body).toContain("Detailed instructions");
  });

  it("derives name from path when frontmatter is missing", () => {
    const raw = "# Some skill\n\nFirst paragraph here.\n\nSecond paragraph.";
    const parsed = parseSkill(raw, "/skills/audit/SKILL.md");
    expect(parsed?.metadata.name).toBe("Some skill");
    expect(parsed?.metadata.description).toBe("First paragraph here.");
  });

  it("strips quotes from frontmatter values", () => {
    const raw = ["---", 'name: "quoted-name"', "description: 'single-quoted'", "---", "body"].join(
      "\n",
    );
    const parsed = parseSkill(raw, "/x/SKILL.md");
    expect(parsed?.metadata.name).toBe("quoted-name");
    expect(parsed?.metadata.description).toBe("single-quoted");
  });

  it("falls back to description for whenToUse if missing", () => {
    const raw = "---\nname: x\ndescription: only desc\n---\nbody";
    const parsed = parseSkill(raw, "/x/SKILL.md");
    expect(parsed?.metadata.whenToUse).toBe("only desc");
  });
});
