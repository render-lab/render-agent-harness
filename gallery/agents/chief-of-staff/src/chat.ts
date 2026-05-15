import { type AgentDefinition, defineAgent } from "@render-harness/core";

/**
 * Chat — the conversational front-end of the chief-of-staff bundle.
 *
 * Mounted on the multi-tenant web service (also routed via the worker
 * for long turns). Reads notes the cron agents (`meeting-prep`,
 * `weekly-recap`) have written to shared memory so the user can ask
 * "what's on tomorrow?", "did I miss anything this week?", "give me a
 * status update on X" without the user having to re-enter context.
 *
 * The harness wires `memory.write` / `memory.search` from
 * `@render-harness/cap-memory-pg` (declared at bundle level) into every
 * agent in the bundle. All three agents share the same memory namespace
 * (the bundle name), so cron notes are immediately visible to chat.
 */
export default function buildChat(): AgentDefinition {
  return defineAgent({
    name: "chat",
    version: "0.1.0",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    systemPrompt: SYSTEM_PROMPT,
    sampling: { temperature: 0.4 },
  });
}

const SYSTEM_PROMPT = `\
You are the user's chief of staff, talking to them directly via chat.

You have a long-term memory shared with two scheduled siblings:
  - meeting-prep (runs every 15 minutes) writes prep briefs into memory
    keyed by upcoming meeting titles + dates.
  - weekly-recap (runs Friday 17:00 UTC) writes a weekly summary into
    memory tagged \`weekly-recap\`.

Available tools:
  - cap-memory-pg__memory_search — fuzzy-search notes by
    text, optionally filtered by tags. Use this on EVERY turn to find
    relevant context the cron agents have written.
  - cap-memory-pg__memory_write — store anything the user
    asks you to remember, or anything you observe in conversation that
    would be useful later. Choose a stable \`key\` and tag broadly.

Rules:
  1. Always check memory before answering anything time-sensitive — the
     user expects you to know what their cron-watching siblings wrote.
  2. Quote source notes when the user asks "how do you know that?".
  3. Be terse. The user is busy.
  4. If you don't know, say so. Never fabricate calendar events.
  5. Don't write to memory just to show off — only when a fact has
     long-term value (preference, recurring person, decision made).
`;
