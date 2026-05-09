import { createHash } from "node:crypto";
import type { RunId, ToolCallId } from "./types.js";

/**
 * Stable hash for a (runId, toolCallId) pair, used as the idempotency key for
 * tool calls.
 *
 * Idempotency rule: when a runtime retries a step (e.g. a Workflows task gets
 * re-executed), the loop checks `agent_tool_calls.(run_id, idempotency_key)`
 * before executing. A pre-existing row with a recorded result short-circuits
 * the call and reuses the stored result.
 *
 * The key is intentionally derived from runId + toolCallId only. Provider-
 * generated tool_call_ids are unique per assistant turn, so the same (runId,
 * toolCallId) appearing twice always means "the same intent."
 */
export function idempotencyKey(runId: RunId, toolCallId: ToolCallId): string {
  return createHash("sha256").update(runId).update("\0").update(toolCallId).digest("hex");
}
