import { describe, expect, it } from "vitest";
import { slackTools } from "./tools.js";

describe("slackTools", () => {
  it("registers read tools by default", () => {
    const names = slackTools({ botToken: "xoxb-test", accessMode: "read" }).map(
      (tool) => tool.definition.name,
    );
    expect(names).toEqual(["slack.get_thread", "slack.get_channel_history"]);
  });

  it("registers write tools in read_write mode", () => {
    const names = slackTools({ botToken: "xoxb-test", accessMode: "read_write" }).map(
      (tool) => tool.definition.name,
    );
    expect(names).toContain("slack.send_message");
    expect(names).toContain("slack.add_reaction");
    expect(names).toContain("slack.update_message");
  });
});
