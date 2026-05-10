import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ContentBlock, MessageRecord } from "../api.js";

/**
 * Translate one persisted `MessageRecord` into the shape assistant-ui's
 * external-store runtime expects.
 *
 * Mapping:
 *   - text       → text part
 *   - thinking   → reasoning part (rendered behind a disclosure)
 *   - tool_use   → tool-call part (args only; the result lands as a separate
 *                  text part on the following tool message)
 *   - tool_result → text part prefixed with `[tool result]` or `[tool error]`
 *
 * `tool` role messages are surfaced as `system` because assistant-ui doesn't
 * model a tool role at the thread level. Rendering them as compact system
 * notes is good enough for v1; the operator's Runs tab keeps the full
 * untranslated tool-call timeline for deeper debugging.
 */
export function convertMessage(msg: MessageRecord): ThreadMessageLike {
  const role: ThreadMessageLike["role"] = msg.role === "tool" ? "system" : msg.role;
  const content = msg.content.map(blockToPart);
  return {
    id: msg.id,
    role,
    content,
    createdAt: new Date(msg.createdAt),
  };
}

type ThreadPart = Exclude<ThreadMessageLike["content"], string>[number];

function blockToPart(block: ContentBlock): ThreadPart {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking") {
    return { type: "reasoning", text: block.thinking };
  }
  if (block.type === "tool_use") {
    // assistant-ui types `args` as ReadonlyJSONObject; we round-trip through
    // JSON to drop any non-serializable fields (functions, undefined, etc.)
    // and to satisfy the structural contract.
    const args = toJsonObject(block.input);
    return {
      type: "tool-call",
      toolCallId: block.id,
      toolName: block.name,
      args,
      argsText: safeJsonStringify(block.input),
    };
  }
  if (block.type === "tool_result") {
    return {
      type: "text",
      text: block.is_error
        ? `[tool error] ${block.content}`
        : `[tool result] ${block.content}`,
    };
  }
  return { type: "text", text: JSON.stringify(block) };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toJsonObject(value: unknown): Readonly<Record<string, never>> & object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {} as Readonly<Record<string, never>>;
  }
  try {
    const round = JSON.parse(JSON.stringify(value));
    if (round === null || typeof round !== "object" || Array.isArray(round)) {
      return {} as Readonly<Record<string, never>>;
    }
    return round as Readonly<Record<string, never>>;
  } catch {
    return {} as Readonly<Record<string, never>>;
  }
}
