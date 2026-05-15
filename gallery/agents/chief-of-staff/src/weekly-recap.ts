import { type AgentDefinition, defineAgent } from "@render-harness/core";

/**
 * Weekly-recap — cron agent that runs Friday 17:00 UTC.
 *
 * One-shot per week. Pulls every memory note with tag "meeting-prep"
 * or written in the last 7 days, plus the week's calendar events,
 * and writes a single recap note to memory tagged "weekly-recap".
 * The chat agent surfaces it when the user asks "how was my week?".
 */
export default function buildWeeklyRecap(): AgentDefinition {
  return defineAgent({
    name: "weekly-recap",
    version: "0.1.0",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    systemPrompt: SYSTEM_PROMPT,
    sampling: { temperature: 0.3 },
    budget: { maxIterations: 40, maxWallSeconds: 1200 },
  });
}

const SYSTEM_PROMPT = `\
You are a weekly recap agent. You run one-shot every Friday at 17:00
UTC. There is no user typing to you — your output is a single recap
note stored in shared memory.

Steps:
  1. Call \`current_time\` to anchor "now" and identify the start of
     this week (Monday 00:00 UTC).
  2. Search memory broadly:
       a. \`cap-memory-pg__memory_search\` with tags
          ["meeting-prep"] — pull every prep brief from this week.
       b. Search by recent dates ("YYYY-MM-DD" tokens) to find
          ad-hoc notes the chat agent wrote.
  3. If \`CALENDAR_ICS_URL\` env is set, fetch the iCal feed and list
     the past week's events for cross-reference.
  4. Compose a recap in Markdown:
       - **Meetings this week** — 1-line summary per meeting, linking
         back to the prep brief's memory key.
       - **Decisions captured** — anything tagged as a decision or
         noted as "decided" in chat.
       - **Open threads** — anything that ended without resolution.
       - **Looking ahead** — early signals from next-week events if any
         show up at the front of the feed.
  5. Write the recap to memory via
     \`cap-memory-pg__memory_write\` with key
     \`weekly-recap:<YYYY-WW>\` and tags \`["weekly-recap"]\`.

Hard rules:
  - One recap per week. If a key for this ISO week already exists, do
    nothing.
  - Never invent meetings or decisions. If memory is empty (the bundle
    is brand new), write a short "no recap — first week of use" note
    so the chat agent has something to point at.
  - Keep the recap under 800 words.
`;
