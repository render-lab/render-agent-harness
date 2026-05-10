import { loadToolResult } from "../state/repo.js";
import type { LocalToolHandler, RunId, ToolCallId } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `fetch_full_result(tool_call_id)` — return the full payload of a prior
 * tool call from `agent_tool_results`. Used to recover from the
 * truncation policy when the agent decides it needs more.
 */
export const fetchFullResultFactory: BuiltinFactory = (ctx) => ({
  registered: true,
  handler: buildHandler(ctx),
});

function buildHandler(ctx: { pool: import("pg").Pool; runId: RunId }): LocalToolHandler {
  return {
    definition: {
      name: "fetch_full_result",
      description:
        "Fetch the complete, untruncated payload of a previous tool call. Pass the tool_call_id you saw in the truncation footer.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tool_call_id: {
            type: "string",
            description: "The tool_call_id from the truncated tool_result you want to fully read.",
          },
        },
        required: ["tool_call_id"],
      },
    },
    handler: async ({ input, runId }) => {
      const toolCallId = (input as { tool_call_id?: string } | null)?.tool_call_id as
        | ToolCallId
        | undefined;
      if (!toolCallId) {
        return {
          content: "fetch_full_result: missing or invalid `tool_call_id`",
          isError: true,
        };
      }
      const result = await loadToolResult(ctx.pool, toolCallId);
      if (!result) {
        return {
          content: `fetch_full_result: no stored result for tool_call_id ${toolCallId}`,
          isError: true,
        };
      }
      if (result.runId !== runId) {
        return {
          content: `fetch_full_result: tool_call_id ${toolCallId} belongs to a different run`,
          isError: true,
        };
      }
      return { content: result.content };
    },
  };
}
