import { describe, expect, it } from "vitest";
import { normalizeIntercomWebhook } from "./normalize.js";

describe("normalizeIntercomWebhook", () => {
  it("returns noop for ping events", () => {
    expect(normalizeIntercomWebhook({ type: "ping" })).toEqual({
      kind: "noop",
      reason: "ping",
    });
  });

  it("returns noop when topic is missing", () => {
    expect(normalizeIntercomWebhook({ type: "notification_event" })).toEqual({
      kind: "noop",
      reason: "no_topic",
    });
  });

  it("returns noop for unsupported topics", () => {
    const r = normalizeIntercomWebhook({
      type: "notification_event",
      topic: "company.contact.added",
      app_id: "w1",
      id: "n1",
      data: { item: {} },
    });
    expect(r.kind).toBe("noop");
    if (r.kind === "noop") expect(r.reason).toMatch(/^unsupported_topic:/);
  });

  it("normalizes a conversation.user.created event with source body", () => {
    const r = normalizeIntercomWebhook({
      type: "notification_event",
      topic: "conversation.user.created",
      app_id: "workspace-abc",
      id: "notif-xyz",
      delivery_attempts: 1,
      data: {
        item: {
          id: "conv-123",
          type: "conversation",
          state: "open",
          source: {
            body: "<p>Hi, my export is broken.</p>",
            author: { name: "Alice", type: "user" },
          },
        },
      },
    });
    expect(r).toEqual({
      kind: "conversation_event",
      topic: "conversation.user.created",
      workspaceId: "workspace-abc",
      conversationId: "conv-123",
      conversationState: "open",
      notificationId: "notif-xyz",
      deliveryAttempt: 1,
      latestMessageBody: "<p>Hi, my export is broken.</p>",
      latestMessageAuthor: "Alice",
    });
  });

  it("prefers the latest comment from conversation_parts over the initial source body", () => {
    const r = normalizeIntercomWebhook({
      type: "notification_event",
      topic: "conversation.user.replied",
      app_id: "w1",
      id: "n1",
      delivery_attempts: 2,
      data: {
        item: {
          id: "c1",
          type: "conversation",
          state: "open",
          source: { body: "initial", author: { name: "Alice" } },
          conversation_parts: {
            conversation_parts: [
              { part_type: "comment", body: "first reply", author: { name: "Bob" } },
              { part_type: "comment", body: "latest reply", author: { name: "Carol" } },
            ],
          },
        },
      },
    });
    expect(r.kind).toBe("conversation_event");
    if (r.kind !== "conversation_event") return;
    expect(r.latestMessageBody).toBe("latest reply");
    expect(r.latestMessageAuthor).toBe("Carol");
    expect(r.deliveryAttempt).toBe(2);
  });

  it("returns noop when the item isn't a conversation", () => {
    const r = normalizeIntercomWebhook({
      type: "notification_event",
      topic: "conversation.user.created",
      app_id: "w1",
      id: "n1",
      data: { item: { id: "x", type: "contact" } },
    });
    expect(r).toEqual({ kind: "noop", reason: "item_not_conversation" });
  });

  it("returns noop when app_id or notification id is missing", () => {
    expect(
      normalizeIntercomWebhook({
        type: "notification_event",
        topic: "conversation.user.created",
        id: "n1",
        data: { item: { id: "c1", type: "conversation" } },
      }),
    ).toEqual({ kind: "noop", reason: "no_app_id" });

    expect(
      normalizeIntercomWebhook({
        type: "notification_event",
        topic: "conversation.user.created",
        app_id: "w1",
        data: { item: { id: "c1", type: "conversation" } },
      }),
    ).toEqual({ kind: "noop", reason: "no_notification_id" });
  });
});
