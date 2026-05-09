import { parseArgs } from "node:util";
import { triggerAgentWorkflow } from "@render-harness/runtime-workflows";
import { config as loadEnv } from "dotenv";
import { buildDeployAgent } from "./agent.js";

loadEnv({ quiet: true });

/**
 * CLI to start (or resume) a deploy-agent workflow run.
 *
 * Usage:
 *
 *   pnpm trigger --repo https://github.com/owner/name [--name my-app] [--branch main]
 *   pnpm trigger --resume <runId> --approve <toolUseId> [--approve <other>]
 *
 * Reads RENDER_API_KEY from the environment so the SDK can authenticate.
 * The workflow service slug must match the slug shown on the Workflow's
 * page in the Render Dashboard; default is "deploy-agent". Override with
 * --workflow.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      name: { type: "string" },
      branch: { type: "string" },
      resume: { type: "string" },
      approve: { type: "string", multiple: true },
      workflow: { type: "string" },
      task: { type: "string" },
      await: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const workflowSlug = values.workflow ?? "deploy-agent";
  const taskName = values.task ?? "agent-step";
  const taskRef = `${workflowSlug}/${taskName}`;
  const agent = buildDeployAgent();

  if (values.resume) {
    if (!values.approve || values.approve.length === 0) {
      throw new Error(
        "--resume requires at least one --approve <toolUseId>. See the previous step's `payload.tool_use_id`.",
      );
    }
    const _result = await triggerAgentWorkflow({
      taskRef,
      runId: values.resume,
      agentName: agent.name,
      agentVersion: agent.version,
      approvedToolCallIds: values.approve,
      await: values.await ?? false,
    });
    return;
  }

  if (!values.repo) {
    throw new Error(
      "missing --repo. Pass --repo https://github.com/owner/name (and optionally --name, --branch).",
    );
  }

  const input = {
    repo: values.repo,
    ...(values.name ? { name: values.name } : {}),
    ...(values.branch ? { branch: values.branch } : {}),
  };

  const _result = await triggerAgentWorkflow({
    taskRef,
    agentName: agent.name,
    agentVersion: agent.version,
    initialContent: [{ type: "text", text: JSON.stringify(input) }],
    metadata: { source: "trigger.ts", input },
    await: values.await ?? false,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
