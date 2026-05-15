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
 * model a tool role at the thread level. assistant-ui enforces that system
 * messages contain exactly one text part, so multi-block tool messages are
 * concatenated into a single text part. The operator's Runs tab keeps the
 * full untranslated tool-call timeline for deeper debugging.
 */
export function convertMessage(msg: MessageRecord): ThreadMessageLike {
  const role: ThreadMessageLike["role"] = msg.role === "tool" ? "system" : msg.role;
  const parts = msg.content.map(blockToPart);
  // assistant-ui constraint: system messages MUST have exactly one text
  // part. Collapse multi-part tool/system messages into a single text
  // blob; fall back to a placeholder if there's nothing renderable.
  const content =
    role === "system" ? [collapseToSingleText(parts)] : parts;
  return {
    id: msg.id,
    role,
    content,
    createdAt: new Date(msg.createdAt),
  };
}

function collapseToSingleText(parts: ThreadPart[]): { type: "text"; text: string } {
  if (parts.length === 0) return { type: "text", text: "" };
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === "text") chunks.push(p.text);
    else if (p.type === "reasoning") chunks.push(p.text);
    else if (p.type === "tool-call") chunks.push(`[tool-call ${p.toolName}] ${p.argsText ?? ""}`);
    else chunks.push(JSON.stringify(p));
  }
  return { type: "text", text: chunks.join("\n\n") };
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
