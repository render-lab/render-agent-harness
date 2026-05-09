import { type RunStepResult, runAgentStep } from "@render-harness/runtime-workflows";
import { task } from "@renderinc/sdk/workflows";
import { config as loadEnv } from "dotenv";
import { buildDeployAgent } from "./agent.js";

loadEnv({ quiet: true });

/**
 * Workflow service entry point. The Render Workflows SDK auto-starts a task
 * server when this module loads in a workflow runtime (RENDER_SDK_SOCKET_PATH
 * is set), so all we have to do is call `task(...)` at top level.
 *
 * The single registered task wraps `runAgentStep` from runtime-workflows.
 * On checkpoint it self-recurses (chained subtask, visible in the Workflows
 * UI). On terminal/paused it returns to the parent.
 */

const agent = buildDeployAgent();

interface StepInput {
  /** Stable agent_runs.id; the trigger CLI / web service creates the row. */
  runId: string;
  /** Tool-use ids approved by the operator since the last pause. */
  approvedToolCallIds?: string[];
}

const agentStep = task(
  {
    name: "agent-step",
    retry: { maxRetries: 2, waitDurationMs: 5_000, backoffScaling: 2 },
  },
  async function agentStep(input: StepInput): Promise<RunStepResult> {
    const result = await runAgentStep({
      agent,
      runId: input.runId,
      ...(input.approvedToolCallIds && input.approvedToolCallIds.length > 0
        ? { approvedToolCallIds: input.approvedToolCallIds }
        : {}),
    });

    if (result.status === "checkpoint") {
      // Soft checkpoint reached. Recurse as a subtask so the Workflows UI
      // shows each step as its own line in the run timeline. The subtask
      // inherits a fresh task timeout (default 7200s).
      return await agentStep({ runId: input.runId });
    }

    // completed | failed | cancelled | paused: return to the parent.
    return result;
  },
);

// Reference the symbol so the bundler doesn't tree-shake the registration
// away. The task() call already had its registration side effect, but
// keeping the export is conventional.
export { agentStep };
