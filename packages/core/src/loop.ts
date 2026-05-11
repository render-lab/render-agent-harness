import type { Pool } from "pg";
import type { Logger } from "pino";
import type { LLMClient } from "./adapters/index.js";
import { resolveClient } from "./adapters/index.js";
import { buildBuiltinTools } from "./builtins/index.js";
import { addUsage, estimateCost } from "./cost.js";
import { serializeError } from "./errors.js";
import {
  collectToolUses,
  executeToolCall,
  finishWithoutToolCalls,
  replayPendingToolUses,
  type ToolExecutionContext,
} from "./loop-steps.js";
import type { McpToolHandle } from "./mcp.js";
import { connectMcpServers } from "./mcp.js";
import { assembleSystemPrompt } from "./prompt.js";
import {
  appendMessage,
  listMessages,
  loadRun,
  mergeRunMetadata,
  setRunStatus,
  updateRunCursor,
} from "./state/repo.js";
import {
  type AgentDefinition,
  type Budget,
  type CheckpointPolicy,
  type ContentBlock,
  DEFAULT_BUDGET,
  DEFAULT_SOFT_CHECKPOINT,
  type Message,
  type RunCursor,
  type RunId,
  type RunStepResult,
  type RuntimeHooks,
  type SkillMetadata,
  type TokenUsage,
  type ToolDefinition,
} from "./types.js";

export interface RunAgentDeps {
  pool: Pool;
  logger: Logger;
  /**
   * Optional pre-resolved LLMClient. If not provided, the loop resolves one
   * from {@link AgentDefinition.model}.
   */
  client?: LLMClient;
  /**
   * Optional pre-discovered skills. If not provided, the loop reads them from
   * the agent's `skills` config.
   */
  skills?: SkillMetadata[];
  /**
   * Optional already-connected MCP tools. If provided, the loop will not
   * connect new MCP servers (use this to share connections across runs in a
   * worker pserv).
   */
  externalMcpTools?: McpToolHandle[];
}

export interface RunAgentArgs {
  runId: RunId;
  agentDef: AgentDefinition;
  signal: AbortSignal;
  checkpoint?: CheckpointPolicy;
  hooks?: RuntimeHooks;
  /**
   * Tool-use ids that the caller has approved for execution despite being in
   * the agent's `permissions.requireApproval` list. Used to resume a paused
   * (`awaiting_approval`) run after a human reviews the proposed tool call.
   *
   * Pass the `tool_use_id` from the previous step's
   * `{ status: "paused", payload: { tool_use_id, ... } }` result.
   */
  approvedToolCallIds?: ReadonlySet<string>;
}

export async function runAgent(args: RunAgentArgs, deps: RunAgentDeps): Promise<RunStepResult> {
  const { runId, agentDef, signal } = args;
  const checkpoint = args.checkpoint ?? DEFAULT_SOFT_CHECKPOINT;
  const hooks = args.hooks ?? {};
  const { pool, logger } = deps;

  const log = logger.child({ runId, agent: agentDef.name });
  const run = await loadRun(pool, runId);
  if (!run) {
    return failed(pool, runId, {
      name: "RunNotFound",
      message: `runAgent: run ${runId} not found`,
    });
  }
  if (run.status === "completed" || run.status === "cancelled" || run.status === "failed") {
    log.info({ status: run.status }, "run already terminal; nothing to do");
    return run.status === "completed"
      ? { status: "completed", finalMessage: await loadFinalMessage(pool, runId) }
      : run.status === "cancelled"
        ? { status: "cancelled" }
        : { status: "failed", error: { name: "RunFailed", message: "run previously failed" } };
  }

  await setRunStatus(pool, runId, "running");

  const skills = deps.skills ?? (await loadAgentSkills(agentDef));
  const { tools: builtinTools, skipped: skippedBuiltins } = buildBuiltinTools({
    pool,
    skills,
    runId,
    userId: run.userId,
    agentName: agentDef.name,
    logger: log,
    env: process.env,
  });
  if (skippedBuiltins.length > 0) {
    log.debug(
      { skipped: skippedBuiltins.map((s) => `${s.name}: ${s.reason}`) },
      "some builtin tools skipped",
    );
    // Stash on the run so the operator UI can show "image_generate (skipped:
    // OPENAI_API_KEY not set)" without having to grep logs. Best-effort —
    // failure to write here doesn't block the run.
    await mergeRunMetadata(pool, runId, { skippedBuiltins }).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to record skipped builtins",
      );
    });
  }
  const localTools = [...(agentDef.localTools ?? []), ...builtinTools];
  let mcp: { tools: McpToolHandle[]; closeAll: () => Promise<void> } | null = null;
  if (deps.externalMcpTools) {
    mcp = { tools: deps.externalMcpTools, closeAll: async () => {} };
  } else if (agentDef.mcpServers && agentDef.mcpServers.length > 0) {
    mcp = await connectMcpServers({ configs: agentDef.mcpServers, logger: log });
  }
  const mcpTools = mcp?.tools ?? [];

  const allToolDefs: ToolDefinition[] = [
    ...localTools.map((t) => t.definition),
    ...mcpTools.map((t) => t.definition),
  ];

  const allowed = filterByPermissions(allToolDefs, agentDef);

  const client = deps.client ?? resolveClient(agentDef.model);
  const budget: Budget = { ...DEFAULT_BUDGET, ...(agentDef.budget ?? {}) };
  const systemPrompt = assembleSystemPrompt({ agent: agentDef, skills });

  const cursor: RunCursor = { ...run.cursor };
  let totalCost = run.totalCostUsd;
  const wallStart = Date.now();
  let toolCallsThisStep = 0;
  let lastAssistantMessage: Message | null = null;

  const toolCtx: ToolExecutionContext = {
    pool,
    logger: log,
    hooks,
    runId,
    signal,
    agentDef,
    localTools,
    mcpTools,
    ...(args.approvedToolCallIds ? { approvedToolCallIds: args.approvedToolCallIds } : {}),
  };

  try {
    for (let iter = 0; iter < budget.maxIterations; iter++) {
      throwIfAborted(signal);
      if (overBudget({ cursor, wallStart, totalCost, budget })) {
        log.warn({ cursor, totalCost, budget }, "budget exhausted");
        return await failed(pool, runId, {
          name: "BudgetExceeded",
          message: "budget exceeded (iterations / wall / tokens / cost)",
          code: "budget_exceeded",
        });
      }
      const messages = await listMessages(pool, runId);

      // Resume detection: if the last persisted message is an assistant turn
      // whose tool_uses were never fulfilled, replay those tool_uses instead
      // of re-prompting the model.
      const pending = replayPendingToolUses(messages);
      let assistantContent: ContentBlock[];
      let assistant: Message;
      if (pending) {
        log.info(
          { pendingCount: pending.toolUses.length },
          "resuming run with unfulfilled tool_uses",
        );
        assistantContent = pending.assistantContent;
        assistant = pending.assistantMessage;
      } else {
        const completion = await client.complete({
          model: agentDef.model,
          system: systemPrompt,
          tools: allowed,
          messages,
          ...(agentDef.sampling ? { sampling: agentDef.sampling } : {}),
          signal,
        });

        cursor.usage = addUsage(cursor.usage, completion.usage);
        cursor.turn += 1;
        const turnCost = estimateCost(agentDef.model, completion.usage).totalUsd;
        totalCost += turnCost;
        cursor.wallMs = Date.now() - wallStart + run.cursor.wallMs;
        await updateRunCursor(pool, runId, cursor, totalCost);
        await hooks.onTokenUsage?.(completion.usage);

        assistant = await appendMessage(pool, {
          runId,
          role: "assistant",
          content: completion.message.content,
          usage: completion.usage,
        });
        await hooks.onMessage?.(assistant);
        assistantContent = completion.message.content;
      }
      lastAssistantMessage = assistant;

      const toolUses = collectToolUses(assistantContent);
      if (toolUses.length === 0) {
        return await finishWithoutToolCalls({ pool, runId, assistant });
      }

      // Execute each tool call. A single assistant turn can request multiple
      // parallel tool calls; we run them sequentially for now (deterministic,
      // simpler error handling). Parallel dispatch is a v2 optimization.
      const toolResultBlocks: ContentBlock[] = [];
      for (const use of toolUses) {
        throwIfAborted(signal);
        const outcome = await executeToolCall(toolCtx, use);
        if (outcome.kind === "paused") {
          return outcome.result;
        }
        toolResultBlocks.push(outcome.block);
        cursor.toolCalls += 1;
        toolCallsThisStep += 1;
      }

      const toolMsg = await appendMessage(pool, {
        runId,
        role: "tool",
        content: toolResultBlocks,
      });
      await hooks.onMessage?.(toolMsg);
      cursor.wallMs = Date.now() - wallStart + run.cursor.wallMs;
      await updateRunCursor(pool, runId, cursor, totalCost);

      // Should we yield back to the runtime here?
      if (shouldCheckpoint(checkpoint, { toolCallsThisStep, wallMs: cursor.wallMs })) {
        log.info({ cursor }, "soft checkpoint reached; yielding to runtime");
        return { status: "checkpoint", cursor };
      }
    }
    // Iteration cap.
    return await failed(pool, runId, {
      name: "MaxIterations",
      message: `maxIterations (${budget.maxIterations}) reached without final answer`,
      code: "max_iterations",
    });
  } catch (err) {
    if (signal.aborted) {
      await setRunStatus(pool, runId, "cancelled");
      return { status: "cancelled" };
    }
    return await failed(pool, runId, serializeError(err));
  } finally {
    if (mcp && !deps.externalMcpTools) {
      await mcp.closeAll();
    }
    log.info(
      {
        cursor,
        totalCost,
        durationMs: Date.now() - wallStart,
        finalMessageId: lastAssistantMessage?.id,
      },
      "runAgent done",
    );
  }
}

// --------------------------------------------------------------------
// Driver-only helpers (everything composable lives in loop-steps.ts)
// --------------------------------------------------------------------

function filterByPermissions(tools: ToolDefinition[], agent: AgentDefinition): ToolDefinition[] {
  const denied = new Set(agent.permissions?.deniedTools ?? []);
  const allowed = agent.permissions?.allowedTools;
  return tools.filter((t) => {
    if (denied.has(t.name)) return false;
    if (allowed && allowed.length > 0 && !allowed.includes(t.name)) return false;
    return true;
  });
}

function shouldCheckpoint(
  policy: CheckpointPolicy,
  state: { toolCallsThisStep: number; wallMs: number },
): boolean {
  switch (policy.kind) {
    case "run-to-completion":
      return false;
    case "every-tool-call":
      return state.toolCallsThisStep > 0;
    case "soft":
      return (
        state.toolCallsThisStep >= policy.maxToolCalls || state.wallMs >= policy.maxSeconds * 1000
      );
  }
}

function overBudget(args: {
  cursor: RunCursor;
  wallStart: number;
  totalCost: number;
  budget: Budget;
}): boolean {
  const { cursor, wallStart, totalCost, budget } = args;
  const wallSec = (Date.now() - wallStart) / 1000;
  if (wallSec >= budget.maxWallSeconds) return true;
  if (totalCost >= budget.maxCostUsd) return true;
  if (cursor.usage.inputTokens + cursor.usage.outputTokens >= budget.maxTokens) {
    return true;
  }
  return false;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
}

async function failed(
  pool: Pool,
  runId: RunId,
  err: { name: string; message: string; stack?: string; code?: string },
): Promise<RunStepResult> {
  await setRunStatus(pool, runId, "failed", { error: err });
  return { status: "failed", error: err };
}

async function loadFinalMessage(pool: Pool, runId: RunId): Promise<Message> {
  const messages = await listMessages(pool, runId);
  const last = messages[messages.length - 1];
  if (!last) throw new Error(`loadFinalMessage: no messages for run ${runId}`);
  return last;
}

async function loadAgentSkills(agent: AgentDefinition): Promise<SkillMetadata[]> {
  if (!agent.skills) return [];
  if (agent.skills.kind === "explicit") return agent.skills.skills;
  const { loadSkillsFromDirectory } = await import("./skills.js");
  return loadSkillsFromDirectory(agent.skills.path);
}

// Re-export TokenUsage so callers don't need to deep-import.
export type { TokenUsage };
