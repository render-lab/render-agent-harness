import { defineAgent, type McpServerConfig } from "@render-harness/core";
import { serveAgent } from "@render-harness/runtime-web";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

const renderApiKey = process.env.RENDER_API_KEY;
const mcpServers: McpServerConfig[] = renderApiKey
  ? [
      {
        name: "render",
        transport: "http",
        url: process.env.RENDER_MCP_URL ?? "https://mcp.render.com/mcp",
        headers: { Authorization: `Bearer ${renderApiKey}` },
      },
    ]
  : [];

const SYSTEM_PROMPT = `\
You are a helpful chat agent running on Render. Each HTTP request is a fresh, single-turn conversation: the user posts a question, you may use tools, and you produce a single Markdown answer.

${
  mcpServers.length > 0
    ? "Render MCP is connected. You can list services, read deploys and logs, and inspect Postgres / Key Value resources in the user's Render workspace. Use these tools when the question is about the user's account."
    : "No MCP servers are connected. Answer from your training knowledge. The operator can add Render MCP by setting the RENDER_API_KEY environment variable."
}

## Rules

- Keep answers tight. The transport is a single HTTP request — there's no follow-up turn from the user.
- When you call tools, narrate briefly what you're checking before the tool call so the SSE stream is readable.
- If a tool errors, surface the error in your final answer rather than silently retrying — the user sees the SSE stream and will wonder what went wrong.
- Never claim to have done something destructive. Read-only tools are the only ones available.`;

const agent = defineAgent({
  name: "web-chat",
  version: "0.1.0",
  model: {
    provider: "anthropic",
    model: process.env.LLM_MODEL ?? "claude-sonnet-4-7",
  },
  systemPrompt: SYSTEM_PROMPT,
  mcpServers,
  permissions: {
    // Render MCP exposes some destructive tools (delete_service, etc.). Keep
    // this demo strictly read-only; users can opt in by removing this list.
    deniedTools: [
      "render__delete_service",
      "render__delete_postgres",
      "render__delete_keyvalue",
      "render__update_environment_variables",
    ],
  },
  sampling: { temperature: 0.4, maxOutputTokens: 4096 },
});

await serveAgent({ agent });
