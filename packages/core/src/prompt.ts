import type { AgentDefinition, SkillMetadata } from "./types.js";

/**
 * Assemble the system prompt for an agent run.
 *
 * Layout (cache-pinned in this order):
 *
 *   1. Agent system prompt (the developer's authored prompt).
 *   2. Skills index — name + when_to_use for every discovered skill, with a
 *      reminder to call `load_skill(name)` to read full content.
 *   3. Built-in tool guidance (`fetch_full_result` etc).
 *
 * Tool definitions are passed separately to the adapter; the adapter is
 * responsible for adding cache_control to that section as well so the entire
 * stable prefix gets cached.
 */
export function assembleSystemPrompt(args: {
  agent: AgentDefinition;
  skills: SkillMetadata[];
}): string {
  const { agent, skills } = args;
  const sections: string[] = [agent.systemPrompt.trim()];

  if (skills.length > 0) {
    sections.push(skillsIndex(skills));
  }

  sections.push(builtinToolGuide());

  return sections.join("\n\n---\n\n");
}

function skillsIndex(skills: SkillMetadata[]): string {
  const lines: string[] = [
    "## Available skills",
    "",
    "These skills give you targeted guidance for specific situations. Each is summarized here.",
    "Call `load_skill(name)` to read the full skill content before acting on the situation it covers.",
    "",
  ];
  for (const skill of skills) {
    lines.push(`- **${skill.name}** — ${skill.description}`);
    if (skill.whenToUse && skill.whenToUse !== skill.description) {
      lines.push(`  - When to use: ${skill.whenToUse}`);
    }
  }
  return lines.join("\n");
}

function builtinToolGuide(): string {
  return [
    "## Built-in tools",
    "",
    "- `load_skill(name)` — load the full content of a skill by name.",
    "- `fetch_full_result(tool_call_id)` — retrieve the full payload of a previous tool call when the truncated context isn't enough.",
  ].join("\n");
}
