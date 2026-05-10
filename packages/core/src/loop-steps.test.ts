/**
 * Unit tests for the pure helpers extracted from runAgent. The DB- and
 * model-driven steps (executeToolCall, pauseFor*, finishWithoutToolCalls)
 * are exercised end-to-end through the existing loop tests + repo
 * integration tests; this file isolates the pieces that are pure functions
 * over message arrays / agent definitions.
 */

import { describe, expect, it } from "vitest";
import {
  collectToolUses,
  formatAwaitingInputPlaceholder,
  replayPendingToolUses,
  requiresApproval,
} from "./loop-steps.js";
import type { AgentDefinition, ContentBlock, Message } from "./types.js";

function msg(partial: Partial<Message> & Pick<Message, "role" | "content">): Message {
  return {
    id: partial.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    role: partial.role,
    content: partial.content,
    createdAt: partial.createdAt ?? new Date(),
  };
}

describe("collectToolUses", () => {
  it("returns only tool_use blocks", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "thinking" },
      { type: "tool_use", id: "t1", name: "do_thing", input: {} },
      { type: "text", text: "more" },
      { type: "tool_use", id: "t2", name: "do_other", input: { x: 1 } },
    ];
    const uses = collectToolUses(content);
    expect(uses.map((u) => u.id)).toEqual(["t1", "t2"]);
  });

  it("returns empty array when there are no tool uses", () => {
    expect(collectToolUses([{ type: "text", text: "answer" }])).toEqual([]);
  });
});

describe("requiresApproval", () => {
  const agent = (requireApproval?: string[]): AgentDefinition => ({
    name: "x",
    version: "0",
    model: { provider: "anthropic", model: "claude-test" },
    systemPrompt: "",
    ...(requireApproval ? { permissions: { requireApproval } } : {}),
  });

  it("returns false when no permissions are configured", () => {
    expect(requiresApproval("dangerous", agent())).toBe(false);
  });

  it("returns true only for tools listed in requireApproval", () => {
    const a = agent(["dangerous"]);
    expect(requiresApproval("dangerous", a)).toBe(true);
    expect(requiresApproval("safe", a)).toBe(false);
  });
});

describe("formatAwaitingInputPlaceholder", () => {
  it("renders question without options", () => {
    const out = formatAwaitingInputPlaceholder({ question: "Proceed?" });
    expect(out).toContain("Question: Proceed?");
    expect(out).not.toContain("Options:");
  });

  it("renders question with numbered options", () => {
    const out = formatAwaitingInputPlaceholder({
      question: "Which?",
      options: ["A", "B", "C"],
    });
    expect(out).toContain("Question: Which?");
    expect(out).toContain("Options: 1. A | 2. B | 3. C");
  });

  it("ignores empty options array", () => {
    const out = formatAwaitingInputPlaceholder({ question: "Q", options: [] });
    expect(out).not.toContain("Options:");
  });
});

describe("replayPendingToolUses", () => {
  it("returns null when there are no messages", () => {
    expect(replayPendingToolUses([])).toBeNull();
  });

  it("returns null when the last assistant message has no tool_use blocks", () => {
    const messages: Message[] = [
      msg({ role: "user", content: [{ type: "text", text: "hi" }] }),
      msg({ role: "assistant", content: [{ type: "text", text: "answer" }] }),
    ];
    expect(replayPendingToolUses(messages)).toBeNull();
  });

  it("returns null when every tool_use was fulfilled by a later tool_result", () => {
    const messages: Message[] = [
      msg({ role: "user", content: [{ type: "text", text: "go" }] }),
      msg({
        id: "asst-1",
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "do", input: {} }],
      }),
      msg({
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      }),
    ];
    expect(replayPendingToolUses(messages)).toBeNull();
  });

  it("returns the unfulfilled tool_uses when the assistant turn paused mid-batch", () => {
    const messages: Message[] = [
      msg({ role: "user", content: [{ type: "text", text: "go" }] }),
      msg({
        id: "asst-1",
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "first", input: {} },
          { type: "tool_use", id: "t2", name: "second", input: {} },
        ],
      }),
      // Only t1 was fulfilled before the run paused.
      msg({
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      }),
    ];
    const pending = replayPendingToolUses(messages);
    expect(pending).not.toBeNull();
    expect(pending?.toolUses.map((u) => u.id)).toEqual(["t2"]);
    expect(pending?.assistantMessage.id).toBe("asst-1");
  });

  it("walks back to the most recent assistant message, ignoring earlier ones", () => {
    const messages: Message[] = [
      msg({
        id: "asst-old",
        role: "assistant",
        content: [{ type: "tool_use", id: "old", name: "x", input: {} }],
      }),
      msg({
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "old", content: "done" }],
      }),
      msg({ role: "user", content: [{ type: "text", text: "follow-up" }] }),
      msg({
        id: "asst-new",
        role: "assistant",
        content: [{ type: "tool_use", id: "new", name: "y", input: {} }],
      }),
    ];
    const pending = replayPendingToolUses(messages);
    expect(pending?.assistantMessage.id).toBe("asst-new");
    expect(pending?.toolUses.map((u) => u.id)).toEqual(["new"]);
  });
});
