import type { Pool } from "pg";
import type { Logger } from "pino";
import { loadSkillContent } from "./skills.js";
import { loadToolResult } from "./state/repo.js";
import type { LocalToolHandler, RunId, SkillMetadata, ToolCallId } from "./types.js";

/**
 * Built-in tools every agent gets for free:
 *
 *   - `load_skill(name)` returns the body of a SKILL.md.
 *   - `fetch_full_result(tool_call_id)` returns the full payload of a prior
 *     tool call from `agent_tool_results`. Used to recover from the
 *     truncation policy when the agent decides it needs more.
 */
export function buildBuiltinTools(args: {
  pool: Pool;
  skills: SkillMetadata[];
  runId: RunId;
  logger: Logger;
}): LocalToolHandler[] {
  const { pool, skills } = args;
  const skillsByName = new Map(skills.map((s) => [s.name, s] as const));

  const loadSkill: LocalToolHandler = {
    definition: {
      name: "load_skill",
      description:
        "Load the full content of a skill by name. Use this when a skill in the system prompt's skills index is relevant to the current step.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            description: "Exact name of the skill (case-sensitive).",
          },
        },
        required: ["name"],
      },
    },
    handler: async ({ input }) => {
      const name = (input as { name?: string } | null)?.name;
      if (!name || typeof name !== "string") {
        return { content: "load_skill: missing or invalid `name`", isError: true };
      }
      const skill = skillsByName.get(name);
      if (!skill) {
        const known = [...skillsByName.keys()].join(", ") || "(none)";
        return {
          content: `load_skill: no skill named "${name}". Known skills: ${known}`,
          isError: true,
        };
      }
      const body = await loadSkillContent(skill);
      return { content: body };
    },
  };

  const fetchFullResult: LocalToolHandler = {
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
      const result = await loadToolResult(pool, toolCallId);
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

  return [loadSkill, fetchFullResult];
}
