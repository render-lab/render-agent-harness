import { describe, expect, it } from "vitest";
import { slackConversationId } from "./convid.js";

describe("slackConversationId", () => {
  it("is deterministic for a Slack thread", () => {
    const first = slackConversationId({ teamId: "T1", channel: "C1", threadTs: "100.1" });
    const second = slackConversationId({ teamId: "T1", channel: "C1", threadTs: "100.1" });
    expect(first).toBe(second);
    expect(first).toMatch(/^slack-[a-f0-9]{24}$/);
  });

  it("differs across threads", () => {
    expect(slackConversationId({ teamId: "T1", channel: "C1", threadTs: "100.1" })).not.toBe(
      slackConversationId({ teamId: "T1", channel: "C1", threadTs: "100.2" }),
    );
  });
});
