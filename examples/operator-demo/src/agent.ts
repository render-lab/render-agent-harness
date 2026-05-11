import { type AgentDefinition, defineAgent } from "@render-harness/core";

const SYSTEM_PROMPT = `\
You are a friendly demo agent running behind the Render harness operator UI.

The user is chatting with you in real time from the operator's Chat tab.
Read the latest user message in context with the prior turns of this
conversation and respond in Markdown.

Keep answers short — usually one or two paragraphs. If the user asks for a
long explanation, structure it with a heading and bullet points.`;

/**
 * Tiny agent used by the operator-demo example. Has no MCP servers and no
 * local tools; the point of the example is the Chat tab in the operator UI,
 * not the agent itself.
 *
 * Multi-turn chat is driven by the conversations API — each user turn
 * enqueues a new run on the same `conversationId`, and the loop loads full
 * message history across the conversation. No flag on the agent is required.
 */
export function buildDemoAgent(): AgentDefinition {
  return defineAgent({
    name: "operator-demo",
    version: "0.2.0",
    model: {
      provider: "anthropic",
      model: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    },
    systemPrompt: SYSTEM_PROMPT,
    sampling: { temperature: 0.4, maxOutputTokens: 1024 },
  });
}
