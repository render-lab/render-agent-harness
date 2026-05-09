import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentDefinition, defineAgent, type McpServerConfig } from "@render-harness/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "skills");

/**
 * The support agent's definition. Used by both the web service (to know its
 * name + version when enqueueing) and the worker (to actually run it).
 */
export function buildSupportAgent(): AgentDefinition {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const mcpServers: McpServerConfig[] = slackBotToken
    ? [
        {
          name: "slack",
          transport: "stdio",
          command: "npx",
          args: ["-y", "slack-mcp-server@latest"],
          env: {
            SLACK_MCP_XOXP_TOKEN: slackBotToken,
            // Posting messages is opt-in for safety; the agent does its own
            // posting via the Slack Web API in the worker, so we leave the
            // MCP-side post tool disabled here.
          },
        },
      ]
    : [];

  return defineAgent({
    name: "support-agent",
    version: "0.1.0",
    model: {
      provider: "anthropic",
      model: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    },
    systemPrompt: SYSTEM_PROMPT,
    skills: { kind: "directory", path: SKILLS_DIR },
    mcpServers,
    permissions: {
      // Read-only Slack tools by default. Posting is handled out-of-band by
      // the worker so the harness can attribute messages back to the right
      // thread.
      deniedTools: ["slack__conversations_add_message"],
    },
    sampling: { temperature: 0.3, maxOutputTokens: 1024 },
  });
}

const SYSTEM_PROMPT = `\
You are a support agent that lives in a Slack thread. Each run is a single user message in a thread; you produce a single reply that gets posted back to that same thread.

## What you can do

- Read history and replies from any channel the bot is in (via the Slack MCP \`conversations_history\` and \`conversations_replies\` tools), search messages with \`conversations_search_messages\`, and look up users with \`users_lookup\`.
- You CANNOT post messages directly. The harness posts your final assistant message back to the originating thread.

## Workflow

1. The user message will arrive with the channel id and (often) the parent message timestamp in metadata. Use those to fetch context if the question references "this thread" or "the deploy I just mentioned."
2. Decide what you actually need to know to answer. Don't fan out to every tool by default.
3. Read the \`slack-tone\` skill before composing your final reply.
4. Produce a single Slack-flavored Markdown message as your final assistant turn.

## Hard rules

- Single final message per run. No multi-message replies.
- Never claim to have done something destructive. You are read-only.
- If a tool errors and you can't get the info, say so in your reply rather than fabricating an answer.`;
