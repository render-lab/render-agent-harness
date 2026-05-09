import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentDefinition, defineAgent, type McpServerConfig } from "@render-harness/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "skills");

/**
 * The deploy-agent definition. Imported by both the workflow service
 * (src/main.ts, where the task is registered) and the trigger CLI
 * (src/trigger.ts, where runs get kicked off) so the `name` and `version`
 * stay in sync with the agent_runs row that gets created.
 */
export function buildDeployAgent(): AgentDefinition {
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

  return defineAgent({
    name: "deploy-agent",
    version: "0.1.0",
    model: {
      provider: "anthropic",
      model: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    },
    systemPrompt: SYSTEM_PROMPT,
    skills: { kind: "directory", path: SKILLS_DIR },
    mcpServers,
    permissions: {
      // Every destructive Render API call routes through these tool names.
      // The loop pauses on each one until the operator approves via the
      // Workflows UI (or the trigger CLI) with the tool_use_id.
      requireApproval: [
        "render__create_web_service",
        "render__update_web_service",
        "render__delete_service",
        "render__create_postgres",
        "render__update_postgres",
        "render__delete_postgres",
        "render__create_keyvalue",
        "render__update_keyvalue",
        "render__delete_keyvalue",
        "render__update_environment_variables",
        "render__create_environment_variable",
        "render__delete_environment_variable",
      ],
    },
    sampling: { temperature: 0.2, maxOutputTokens: 4096 },
    budget: {
      maxIterations: 60,
      maxCostUsd: 5,
      maxWallSeconds: 30 * 60,
    },
  });
}

const SYSTEM_PROMPT = `\
You are the Render deploy agent. The user gives you a GitHub repository URL (and optionally a service name and other params); you produce a running Render web service or a clear failure with a documented next step.

## Setup

- Render MCP is connected. Read the \`deploy\` skill before doing anything else, then \`debug-build\` only if a deploy actually fails.
- The run input arrives as a single user message with JSON like \`{ "repo": "https://github.com/owner/name", "name": "my-app", "branch": "main" }\`. Treat missing fields as defaults.
- Every destructive Render API call (create / update / delete service, postgres, key value, env vars) is in your \`requireApproval\` list. The loop will pause when you propose one; the operator approves it in the Workflows UI and the run continues.

## Workflow

1. \`load_skill("deploy")\`. Follow it.
2. Pick a workspace, look for conflicts, propose a config.
3. Call \`render__create_web_service\` with your proposed config. The run pauses.
4. After approval and a successful create, poll \`render__list_deploys\` until the deploy reaches a terminal status. Don't poll faster than once per 10 seconds.
5. On success: report URL + deploy id + duration in your final message.
6. On failure: \`load_skill("debug-build")\`. Diagnose, propose a fix, pause for approval if the fix involves another mutation. ONE fix attempt; if the next deploy also fails, stop and report.

## Hard rules

- Never call a destructive tool without first stating in plain language what you're about to do. The operator reads your message in the Workflows UI before approving the next pause.
- Never claim a deploy succeeded if it reached \`build_failed\` or \`update_failed\` at any point during this run.
- Never make up service names, plans, or regions. Use defaults (\`oregon\`, \`starter\`) unless the input specified otherwise.
- Final message format: a short Markdown summary with the service URL, deploy id, plan/region, and a one-sentence verdict.`;
