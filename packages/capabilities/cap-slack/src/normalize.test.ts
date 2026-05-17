import { describe, expect, it } from "vitest";
import { normalizeSlackEvent } from "./normalize.js";

describe("normalizeSlackEvent", () => {
  it("returns url verification challenges", () => {
    expect(normalizeSlackEvent({ type: "url_verification", challenge: "abc" })).toEqual({
      kind: "challenge",
      challenge: "abc",
    });
  });

  it("normalizes app mentions into threaded messages", () => {
    const event = normalizeSlackEvent({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        text: "<@BOT> help",
        ts: "100.1",
      },
    });
    expect(event).toMatchObject({
      kind: "message",
      teamId: "T1",
      channel: "C1",
      userId: "U1",
      text: "<@BOT> help",
      ts: "100.1",
      threadTs: "100.1",
      eventId: "E1",
    });
  });

  it("skips bot messages and disallowed channels", () => {
    expect(
      normalizeSlackEvent({
        type: "event_callback",
        event: { type: "message", channel: "C1", bot_id: "B1", text: "bot", ts: "1" },
      }),
    ).toMatchObject({ kind: "noop", reason: "bot_message" });
    expect(
      normalizeSlackEvent(
        {
          type: "event_callback",
          team_id: "T1",
          event: { type: "message", channel: "C2", text: "hi", ts: "1" },
        },
        { allowedChannels: ["C1"] },
      ),
    ).toMatchObject({ kind: "noop", reason: "channel_not_allowed" });
  });
});
