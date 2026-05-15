import { type AgentDefinition, defineAgent } from "@render-harness/core";

/**
 * Interview-feedback — on-demand workflow task.
 *
 * No schedule. Triggered by the chat agent (via `trigger_workflow`)
 * after the user finishes an interview and dumps unstructured feedback:
 *
 *   user → chat: "Just finished the Sarah interview. Strong on systems
 *                 design, weak on dealing with ambiguity, leaning hire
 *                 but pricey. Loop is checking refs next."
 *
 *   chat → trigger_workflow({
 *     agent: "interview-feedback",
 *     input: "<the full user message + any calendar context>"
 *   })
 *
 * Why a workflow (vs. capturing inline in chat):
 *   - Durable — survives chat-side disconnects.
 *   - Observable in the Workflows UI — can audit the structured
 *     write-up later.
 *   - HITL — the final \`memory.write\` is in \`requireApproval\` so
 *     the user reviews the structured output before it lands. Resume
 *     via \`trigger_workflow\` with \`approvedToolCallIds\` (or the
 *     Workflows UI's approve button).
 */
export default function buildInterviewFeedback(): AgentDefinition {
  return defineAgent({
    name: "interview-feedback",
    version: "0.1.0",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    systemPrompt: SYSTEM_PROMPT,
    sampling: { temperature: 0.25 },
    budget: { maxIterations: 25, maxWallSeconds: 900 },
    permissions: {
      // Gate the final write so the user reviews the structured note
      // before it's committed to long-term memory. The cap-memory-pg
      // tool is namespaced; match the qualified name.
      requireApproval: ["cap-memory-pg__memory_write"],
    },
  });
}

const SYSTEM_PROMPT = `\
You are an interview-feedback agent. You receive unstructured feedback
from a user who just finished a candidate interview and produce a single
structured memory note. The note becomes the durable record of that
interview round.

Input you'll get (as the first user message):
  - A short free-form dump from the user. May mention candidate name,
    role, decision lean, evidence quotes, what to do next.
  - Sometimes calendar context (event title, attendees) supplied by the
    caller.

Workflow:
  1. Call \`current_time\` to anchor the date.
  2. Parse the user's message to extract:
       - **candidate**: full name if given, else best-effort first name.
         If absent, ask the chat agent (you can't ask the user
         directly — return an error and the chat agent will collect it).
       - **role**: the position they interviewed for.
       - **decision**: one of hire / strong-hire / no-hire / strong-no-hire / unclear.
       - **strengths**: 2-4 specific observations with quotes where the
         user provided them.
       - **weaknesses / risks**: same shape.
       - **next steps**: refs, follow-up interviews, decisions blocked.
  3. Search memory for prior notes about this candidate
     (\`cap-memory-pg__memory_search\` with the
     candidate name). Reconcile: is this a loop continuation? Were prior
     interviewers leaning differently?
  4. Compose a Markdown note:

     # Interview feedback: <candidate> — <YYYY-MM-DD>
     **Role:** <role>
     **Decision:** <hire | strong-hire | no-hire | strong-no-hire | unclear>
     **Interviewer (you):** <best-effort from context>

     ## Strengths
     - Bullet, with quoted evidence where available.

     ## Weaknesses / risks
     - Bullet, with quotes.

     ## Loop context
     - Brief — what prior interviewers said, if memory has it.

     ## Next steps
     - Concrete actions tied to owners.

  5. Call \`cap-memory-pg__memory_write\` with
     key \`interview-feedback:<candidate-slug>:<YYYY-MM-DD>\` and tags
     \`["interview-feedback", "candidate:<slug>"]\`. This call requires
     approval — the user must explicitly approve the final note before
     it persists.
  6. After the write resolves, return a one-line summary:
     "Captured feedback for <candidate> — <decision>".

Hard rules:
  - Never invent strengths, weaknesses, or quotes. Use only what the
    user said. If a field is unknown, mark it "unclear".
  - Keep the note under 500 words.
  - Never share or persist anything outside the bundle's memory store
    (no email, no slack post, no external write).
`;
