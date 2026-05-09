import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentDefinition, defineAgent, type Pool } from "@render-harness/core";
import OpenAI from "openai";
import { buildCitationsTools } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "skills");

/**
 * Build the citations-monitor agent. Takes a Postgres pool and a search-engine
 * client (any OpenAI-compatible endpoint) so callers can swap them in tests.
 */
export function buildCitationsAgent(opts: {
  pool: Pool;
  searchClient?: OpenAI;
  searchModel?: string;
  model?: AgentDefinition["model"];
}): AgentDefinition {
  const searchClient =
    opts.searchClient ??
    new OpenAI({
      apiKey: process.env.SEARCH_ENGINE_API_KEY ?? process.env.OPENAI_API_KEY ?? "missing",
      ...(process.env.SEARCH_ENGINE_BASE_URL
        ? { baseURL: process.env.SEARCH_ENGINE_BASE_URL }
        : {}),
    });

  const searchModel = opts.searchModel ?? process.env.SEARCH_ENGINE_MODEL ?? "gpt-5";

  const tools = buildCitationsTools({
    pool: opts.pool,
    searchClient,
    searchModel,
  });

  return defineAgent({
    name: "citations-monitor",
    version: "0.1.0",
    model: opts.model ?? {
      provider: "anthropic",
      model: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    },
    systemPrompt: SYSTEM_PROMPT,
    skills: { kind: "directory", path: SKILLS_DIR },
    localTools: tools,
    budget: {
      maxIterations: 60,
      maxCostUsd: 5,
      maxWallSeconds: 30 * 60,
      maxTokens: 500_000,
    },
    sampling: {
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
  });
}

const SYSTEM_PROMPT = `\
You are the Render citations monitor. Once per cron run, you audit every tracked query against an AI search engine and produce a single Markdown summary that the team reads in the agent_messages table.

## What to do, in order

1. Call \`list_tracked_queries()\` once to get the queries you should audit. Note the \`run_id\` from your run context (it appears in tool result metadata).
2. For each enabled query, in order:
   a. Call \`query_search_engine({ query })\` with the exact query text.
   b. Decide whether the target brand was cited using the \`auditing-protocol\` skill.
   c. Call \`record_audit\` with the result. Pass the full raw response in \`raw_response\` so we can replay it later. Pass a 1–3 sentence quote in \`response_excerpt\`.
3. After all queries are done, call \`summarize_recent_audits({ run_id })\` to confirm the counts.
4. Compose the final summary message following the \`summary-format\` skill exactly. This summary message *is* your final response — no tool calls in the same turn.

## Hard rules

- Never invent audit results. If \`query_search_engine\` errors or returns empty, skip that query and call it out under "Skipped" in the summary.
- Never call \`record_audit\` more than once per (query_id, run). The tool deduplicates by id, but you should still avoid the wasted round trip.
- Read both skills (\`auditing-protocol\` and \`summary-format\`) with \`load_skill\` before processing the first query.
- The summary message is the entire output. Do not start writing prose until you've called \`summarize_recent_audits\`.

## Tone

The summary is read by people who care about week-over-week trends. Be precise, neutral, and short. No filler.`;
