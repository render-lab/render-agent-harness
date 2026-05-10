import { loadSkillContent } from "../skills.js";
import type { LocalToolHandler, SkillMetadata } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `load_skill(name)` — read the body of a SKILL.md by name.
 *
 * Always registers; agents without skills get a tool whose error message
 * lists the (empty) known set, which is harmless.
 */
export const loadSkillFactory: BuiltinFactory = (ctx) => ({
  registered: true,
  handler: buildHandler(ctx.skills),
});

function buildHandler(skills: SkillMetadata[]): LocalToolHandler {
  const skillsByName = new Map(skills.map((s) => [s.name, s] as const));
  return {
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
}
