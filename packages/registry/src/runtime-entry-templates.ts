/**
 * Zero-arg string templates for the runtime entrypoints a sealed
 * bundle scaffolds into `src/<kind>.ts`. Each function returns the
 * verbatim source for one entrypoint:
 *
 *  - `bundleWebEntry()`         — `src/web.ts`, multi-tenant web stack
 *  - `bundleWorkerEntry()`      — `src/worker.ts`, pg-boss worker
 *  - `bundleCronEntry()`        — `src/cron.ts`, dispatched by HARNESS_AGENT_ID
 *  - `bundleCronTriggerEntry()` — `src/cron-trigger.ts`, fires a Workflow task and exits
 *  - `bundleWorkflowsEntry()`   — `src/workflows.ts`, registers task() per workflow agent
 *
 * Each entry loads the bundle once via `defineFromConfig` and hands the
 * resulting `agentsById` map to the runtime.
 *
 * Lives in @render-harness/registry (not create-render-agent) so both
 * consumers stay byte-identical:
 *
 *   1. `create-render-agent` uses them at scaffold time to seed
 *      `src/<kind>.ts` files in a fresh bundle.
 *   2. `@render-harness/web`'s `agent-add` route uses them via
 *      `@render-harness/registry/runtime-entries` to drop a fresh
 *      entrypoint into an existing managed harness when the operator
 *      adds an agent whose runtime kind the project doesn't yet have.
 *
 * The string contents intentionally embed import statements that
 * reference the harness packages (`@render-harness/registry`,
 * `@render-harness/web`, `@render-harness/runtime-*`, `@renderinc/sdk`)
 * as plain source-level imports — they aren't deps of registry itself.
 */

export function bundleWebEntry(): string {
  return `import "dotenv/config";
import { defineFromConfig, enrichDeploymentInfo, toDeploymentInfo } from "@render-harness/registry";
import { serveWeb } from "@render-harness/web";

const configPath = "./render-harness.yaml";

const { agentsById, config, packs } = await defineFromConfig({ configPath });

// enrichDeploymentInfo layers in wizardServiceUrl, repoLocator,
// envSchema (with isSet annotations), and renderService — everything
// the operator UI's Agents + Config tabs need. All fields are
// best-effort; missing pieces just hide the corresponding affordances.
const deployment = await enrichDeploymentInfo(toDeploymentInfo(config), configPath, {
  config,
  packs,
});

const port = Number(process.env.PORT ?? 8080);

await serveWeb({
  agents: agentsById,
  port,
  ui: config.shared?.ui ? { path: "/" } : false,
  connectors: "from-config",
  deployment,
});
`;
}

export function bundleWorkerEntry(): string {
  return `import "dotenv/config";
import { defineFromConfig } from "@render-harness/registry";
import { startWorkerAndWait } from "@render-harness/runtime-worker";

const { agentsById } = await defineFromConfig({
  configPath: "./render-harness.yaml",
});

await startWorkerAndWait({
  agent: async (job) => {
    const found = agentsById[job.agentName];
    if (!found) {
      throw new Error(\`worker: agent "\${job.agentName}" not registered in this bundle\`);
    }
    return found;
  },
});
`;
}

export function bundleCronEntry(): string {
  return `import "dotenv/config";
import { defineFromConfig } from "@render-harness/registry";
import { runCronFromRegistryAndExit } from "@render-harness/runtime-cron";

const agentId = process.env.HARNESS_AGENT_ID ?? "";
const { agentsById } = await defineFromConfig({
  configPath: "./render-harness.yaml",
});

await runCronFromRegistryAndExit({
  agents: agentsById,
  agentId,
});
`;
}

/**
 * Cron-trigger entrypoint. Runs on a Render Cron service whose start
 * command is `node dist/cron-trigger.js`. The emitter sets
 * `WORKFLOW_TASK_REF` to the task identifier and `RENDER_API_KEY` as
 * a deploy-time secret. The trigger does the minimum work to start the
 * workflow run and exits — the actual agent loop runs in the Workflow
 * service.
 */
export function bundleCronTriggerEntry(): string {
  return `import "dotenv/config";
import { triggerAgentWorkflow } from "@render-harness/runtime-workflows";

const taskRef = process.env.WORKFLOW_TASK_REF;
const agentId = process.env.HARNESS_AGENT_ID;
if (!taskRef || !agentId) {
  console.error(
    "cron-trigger: WORKFLOW_TASK_REF and HARNESS_AGENT_ID env vars are required",
  );
  process.exit(2);
}

try {
  const result = await triggerAgentWorkflow({
    taskRef,
    agentName: agentId,
    agentVersion: "cron-triggered",
    metadata: { source: "cron-trigger" },
  });
  console.log(
    JSON.stringify({
      triggered: { taskRef, runId: result.runId, taskRunId: result.taskRunId },
    }),
  );
  process.exit(0);
} catch (err) {
  console.error(
    "cron-trigger failed:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
`;
}

/**
 * Workflows-service entrypoint. The bundle's single Workflow service
 * runs `node dist/workflows.js`; this file registers every workflow-
 * mode agent in the bundle as one `task()`. New agents added to the
 * manifest become new tasks automatically — Render rebuilds the
 * service on push and discovers the registrations on boot.
 */
export function bundleWorkflowsEntry(): string {
  return `import "dotenv/config";
import { task } from "@renderinc/sdk/workflows";
import { defineFromConfig, isWorkflowTaskAgent } from "@render-harness/registry";
import { runAgentStep } from "@render-harness/runtime-workflows";

const { agentsById, config } = await defineFromConfig({
  configPath: "./render-harness.yaml",
});

interface TaskInput {
  runId?: string;
  approvedToolCallIds?: string[];
}

for (const entry of config.agents) {
  if (!isWorkflowTaskAgent(entry)) continue;
  const agent = agentsById[entry.id];
  if (!agent) continue;
  task(
    { name: entry.id },
    async function agentStep(input: TaskInput = {}) {
      const runId = input.runId ?? globalThis.crypto.randomUUID();
      const result = await runAgentStep({
        agent,
        runId,
        ...(input.approvedToolCallIds && input.approvedToolCallIds.length > 0
          ? { approvedToolCallIds: input.approvedToolCallIds }
          : {}),
      });
      // On checkpoint, the task self-recurses so the Workflows UI shows
      // a chain of subtask rows.
      if (result.status === "checkpoint") {
        // biome-ignore lint/correctness/noSelfAssign: avoid TS complaining about implicit any
        const next: TaskInput = { runId };
        return await agentStep(next);
      }
      return result;
    },
  );
}
`;
}
