import type { LocalToolHandler } from "../types.js";
import type { BuiltinContext, BuiltinFactory } from "./types.js";

/**
 * `trigger_workflow({ agent, input?, await?, metadata? })` — start a
 * Render Workflows run that drives one of the bundle's workflow-mode
 * agents.
 *
 * Composes the task ref as `${WORKFLOW_SLUG}/${agent}` and hands off to
 * `triggerAgentWorkflow` from `@render-harness/runtime-workflows` (lazy-
 * imported to keep the SDK out of the worker's hot path). Pre-creates an
 * `agent_runs` row so the triggered run shows up alongside web/worker/
 * cron runs in our SQL state — unified observability.
 *
 * Tier B — env-gated. Requires:
 *   - `RENDER_API_KEY` — Render API key for the SDK client.
 *   - `WORKFLOW_SLUG`  — slug of the bundle's Workflow service (the
 *     emitter wires this as `<bundle-name>-workflows` for V2 bundles).
 *
 * Permission gate the caller can apply for HITL:
 *   `permissions.requireApproval: ["trigger_workflow"]`
 */
export const triggerWorkflowFactory: BuiltinFactory = (ctx) => {
  const apiKey = ctx.env.RENDER_API_KEY?.trim();
  const slug = ctx.env.WORKFLOW_SLUG?.trim();
  if (!apiKey) {
    return {
      registered: false,
      name: "trigger_workflow",
      reason: "RENDER_API_KEY not set",
    };
  }
  if (!slug) {
    return {
      registered: false,
      name: "trigger_workflow",
      reason: "WORKFLOW_SLUG not set",
    };
  }
  return { registered: true, handler: buildHandler(ctx, slug) };
};

interface Input {
  agent?: string;
  input?: string | Record<string, unknown>;
  await?: boolean;
  metadata?: Record<string, unknown>;
}

function buildHandler(ctx: BuiltinContext, workflowSlug: string): LocalToolHandler {
  return {
    definition: {
      name: "trigger_workflow",
      description: `Start a Render Workflows run for one of this bundle's workflow-mode agents. The target agent must be declared with workflowTask: true in the bundle manifest. Returns the new run id and the workflow task run id; pass await:true to block until the workflow finishes. Workflow slug: "${workflowSlug}".`,
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          agent: {
            type: "string",
            description:
              "Bundle agent id to invoke (must be a workflowTask agent in this bundle).",
            minLength: 1,
          },
          input: {
            description:
              "Initial input for the agent run. Strings are wrapped as a text content block; objects are JSON-serialized as a single text block. Omit if the workflow agent accepts no input.",
            oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
          },
          await: {
            type: "boolean",
            description:
              "When true, wait for the workflow to finish and return its results. Default false (fire-and-forget; returns immediately with the run id).",
          },
          metadata: {
            type: "object",
            description:
              "Free-form metadata persisted on the new agent_runs row (e.g. source, parent run id).",
            additionalProperties: true,
          },
        },
        required: ["agent"],
      },
    },
    handler: async ({ input }) => {
      const args = (input ?? {}) as Input;
      const agentId = (args.agent ?? "").trim();
      if (!agentId) {
        return { content: "trigger_workflow: missing `agent`", isError: true };
      }

      const taskRef = `${workflowSlug}/${agentId}`;

      let triggerAgentWorkflow: TriggerAgentWorkflowFn;
      try {
        triggerAgentWorkflow = await loadTriggerAgentWorkflow();
      } catch (err) {
        return {
          content: `trigger_workflow: @render-harness/runtime-workflows is not installed in this process. Add it as a dependency or use the workflow agent's CLI to deploy. (${err instanceof Error ? err.message : String(err)})`,
          isError: true,
        };
      }

      const initialContent = toInitialContent(args.input);
      const metadata: Record<string, unknown> = {
        ...(args.metadata ?? {}),
        triggeredBy: ctx.agentName,
        triggeredFromRunId: ctx.runId,
      };

      try {
        const result = await triggerAgentWorkflow({
          taskRef,
          agentName: agentId,
          // The target agent's version isn't visible from the caller's
          // process. The Workflow service updates this on receipt; the
          // placeholder is informational only.
          agentVersion: "triggered",
          ...(ctx.userId !== null ? { userId: ctx.userId } : {}),
          ...(initialContent ? { initialContent } : {}),
          metadata,
          ...(args.await === true ? { await: true } : {}),
        });
        return {
          content: JSON.stringify(
            {
              taskRef,
              runId: result.runId,
              taskRunId: result.taskRunId,
              ...(result.status !== undefined ? { status: result.status } : {}),
              ...(result.results !== undefined ? { results: result.results } : {}),
            },
            null,
            2,
          ),
        };
      } catch (err) {
        return {
          content: `trigger_workflow (${taskRef}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

// Local mirror of the slice of triggerAgentWorkflow's API we need. The
// runtime types live in @render-harness/runtime-workflows — duplicating
// the shape here avoids a circular type dep (runtime-workflows already
// depends on core). Mismatches surface at runtime as a clear "@render-
// harness/runtime-workflows is not installed" error from the dynamic
// import branch above.
interface TriggerOpts {
  taskRef: string;
  runId?: string;
  agentName: string;
  agentVersion: string;
  userId?: string;
  initialContent?: Array<{ type: "text"; text: string }>;
  metadata?: Record<string, unknown>;
  approvedToolCallIds?: ReadonlyArray<string>;
  await?: boolean;
}

interface TriggerResult {
  runId: string;
  taskRunId: string;
  status?: string;
  results?: unknown;
}

type TriggerAgentWorkflowFn = (opts: TriggerOpts) => Promise<TriggerResult>;

/**
 * Indirected import. `runtime-workflows` is intentionally not in core's
 * dependency list (it depends on core, so listing it back would be a
 * cycle). The string variable keeps TS from resolving the module at
 * compile time; the bundle's scaffolded `package.json` makes sure the
 * package exists at runtime.
 */
async function loadTriggerAgentWorkflow(): Promise<TriggerAgentWorkflowFn> {
  const pkg = "@render-harness/runtime-workflows";
  const mod = (await import(pkg)) as { triggerAgentWorkflow: TriggerAgentWorkflowFn };
  return mod.triggerAgentWorkflow;
}

function toInitialContent(input: Input["input"]): TriggerOpts["initialContent"] | undefined {
  if (input === undefined || input === null) return undefined;
  const text = typeof input === "string" ? input : JSON.stringify(input);
  if (text.length === 0) return undefined;
  return [{ type: "text", text }];
}
