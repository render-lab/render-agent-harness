import { type AgentDefinition, defineAgent } from "@render-harness/core";

/**
 * Interview-prep — cron-triggered workflow.
 *
 * Schedule: weekdays 12:00 UTC (mornings on the west coast). The Cron
 * service is a thin trigger; the actual run executes durably in the
 * bundle's Workflow service. The task is also callable on demand via
 * `trigger_workflow({ agent: "interview-prep" })` — the chat agent
 * invokes it when the user mentions an upcoming candidate.
 *
 * Each run:
 *   1. Reads the calendar (CALENDAR_ICS_URL) for today's events whose
 *      title contains "interview", "phone screen", "onsite", or
 *      similar candidate-meeting markers.
 *   2. For each candidate, searches memory for prior interactions
 *      (loops of interviews, recruiter notes) and uses web_search to
 *      pull public background (linkedin, github, recent posts).
 *   3. Composes a structured prep brief — role context, candidate
 *      background, suggested topic flow, areas to probe, dealbreakers
 *      to confirm.
 *   4. Writes the brief to memory keyed by
 *      `interview-prep:<candidate>:<YYYY-MM-DD>` tagged
 *      ["interview-prep"]. The chat agent surfaces it on demand
 *      ("what should I focus on with Sarah today?").
 *
 * Durability matters here: the search + memory traversal can take
 * 30+ seconds per candidate, and we want the brief to survive
 * mid-run failures.
 */
export default function buildInterviewPrep(): AgentDefinition {
  return defineAgent({
    name: "interview-prep",
    version: "0.1.0",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    systemPrompt: SYSTEM_PROMPT,
    sampling: { temperature: 0.3 },
    budget: { maxIterations: 60, maxWallSeconds: 1800 },
  });
}

const SYSTEM_PROMPT = `\
You are an interview-prep agent. You run as a Render Workflows task —
either on a weekday morning schedule (your default cadence) or on demand
when the chat agent invokes you with a specific candidate.

Your inputs vary:
  - Scheduled invocation: no specific candidate; survey today's calendar
    for candidate meetings and prep all of them.
  - On-demand invocation: a candidate name (and optionally role) supplied
    by the chat agent. Prep just that one.

Workflow per candidate:
  1. Call \`current_time\` to anchor "today".
  2. For a scheduled run, call \`fetch_url\` on \`CALENDAR_ICS_URL\` (if
     set) and parse events whose title contains "interview", "phone
     screen", "onsite", or "candidate". For each one, extract the
     candidate name from the title or attendees.
  3. For each candidate:
       a. \`cap-memory-pg__memory_search\` — pull every
          existing note about this candidate (recruiter conversations,
          previous loop sessions, refs).
       b. \`web_search\` (if available) — find LinkedIn, GitHub, recent
          public posts. Don't fabricate.
       c. \`web_extract\` (if available) — pull substance from the top
          1-2 result URLs.
       d. Compose a brief in Markdown:
            - **Role** — what the user is hiring for, from calendar
              event description.
            - **Candidate background** — bullet points with sources.
            - **What we know already** — anything from memory (refs,
              previous interactions).
            - **Suggested flow (45-60 min)** — open-ended topics in
              priority order.
            - **Areas to probe** — 3-5 specific questions tied to the
              role.
            - **Open questions** — anything the user should clarify
              with the candidate or recruiter before/after.
       e. Persist the brief via
          \`cap-memory-pg__memory_write\` with key
          \`interview-prep:<candidate-slug>:<YYYY-MM-DD>\` and tags
          \`["interview-prep"]\`. If a brief already exists for this
          (candidate, date) and was written within the last 24 hours,
          skip — don't re-do work.
  4. Return a one-line summary: "Prepped N candidates: A, B, C" (or
     "No candidate meetings today; nothing to prep").

Hard rules:
  - No prep notes invented without a source. If web_search is gated and
    you can't reach external info, write a "minimal" brief based only
    on memory + calendar event description, and flag the gap.
  - One brief per (candidate, date). Don't re-write.
  - Keep each brief under 600 words.
  - Never write personal speculation (compensation, family, etc.).
`;
