import { describe, expect, it } from "vitest";
import { normalizeLinearEvent } from "./normalize.js";

describe("normalizeLinearEvent", () => {
  it("normalizes issue events", () => {
    const event = normalizeLinearEvent({
      type: "Issue",
      action: "update",
      organizationId: "org",
      actor: { id: "user-1" },
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        url: "https://linear.app/render/issue/ENG-123",
        team: { id: "team-1", key: "ENG" },
        project: { id: "project-1", name: "Agent Platform" },
        state: { name: "In Review" },
      },
    });
    expect(event).toMatchObject({
      type: "Issue",
      action: "update",
      organizationId: "org",
      actorId: "user-1",
      teamKey: "ENG",
      projectId: "project-1",
      issueId: "issue-1",
      issueIdentifier: "ENG-123",
      state: "In Review",
    });
  });

  it("filters teams and states", () => {
    const payload = {
      type: "Issue",
      action: "update",
      data: {
        id: "issue-1",
        team: { key: "SUP" },
        state: { name: "Todo" },
      },
    };
    expect(normalizeLinearEvent(payload, { allowedTeams: ["ENG"] })).toBeNull();
    expect(normalizeLinearEvent(payload, { states: ["Done"] })).toBeNull();
  });
});
