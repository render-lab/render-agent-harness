import type { Pool } from "pg";
import type { Logger } from "pino";
import type { LLMClient } from "./adapters/index.js";
import { resolveClient } from "./adapters/index.js";
import { buildBuiltinTools } from "./builtins.js";
import { addUsage, estimateCost } from "./cost.js";
import { idempotencyKey } from "./idempotency.js";
import { connectMcpServers } from "./mcp.js";
import { assembleSystemPrompt } from "./prompt.js";
import {
  appendMessage,
  findExistingToolCall,
  listMessages,
  loadRun,
  recordToolCall,
  recordToolResult,
  setRunStatus,
  setToolCallStatus,
  updateRunCursor,
} from "./state/repo.js";
import { truncateResult } from "./truncate.js";
import {
  type AgentDefinition,
  type Budget,
  type CheckpointPolicy,
  type ContentBlock,
  DEFAULT_BUDGET,
  DEFAULT_SOFT_CHECKPOINT,
  type LocalToolHandler,
  type Message,
  type RunCursor,
  type RunId,
  type RunStepResult,
  type RuntimeHooks,
  type SkillMetadata,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolUseBlock,
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

export interface McpToolHandle {
  exposedName: string;
  serverName: string;
  server: string;
  definition: ToolDefinition;
  call: (input: unknown, signal: AbortSignal) => Promise<{ content: string; isError: boolean }>;
}

export interface RunAgentArgs {
  runId: RunId;
  agentDef: AgentDefinition;
  signal: AbortSignal;
  checkpoint?: CheckpointPolicy;
  hooks?: RuntimeHooks;
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
  const builtinTools = buildBuiltinTools({ pool, skills, runId, logger: log });
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

      const assistant = await appendMessage(pool, {
        runId,
        role: "assistant",
        content: completion.message.content,
        usage: completion.usage,
      });
      lastAssistantMessage = assistant;
      await hooks.onMessage?.(assistant);

      const toolUses = collectToolUses(completion.message.content);
      if (toolUses.length === 0) {
        // No tool calls — model returned a final answer.
        await setRunStatus(pool, runId, "completed");
        return { status: "completed", finalMessage: assistant };
      }

      // Execute each tool call. A single assistant turn can request multiple
      // parallel tool calls; we run them sequentially for now (deterministic,
      // simpler error handling). Parallel dispatch is a v2 optimization.
      const toolResultBlocks: ContentBlock[] = [];
      for (const use of toolUses) {
        throwIfAborted(signal);
        const handler = findHandler(use.name, localTools, mcpTools, runId);
        if (!handler) {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: `tool "${use.name}" is not registered for this agent`,
            is_error: true,
          });
          continue;
        }
        if (requiresApproval(use.name, agentDef)) {
          await setRunStatus(pool, runId, "paused");
          log.info({ tool: use.name }, "paused: awaiting_approval");
          return {
            status: "paused",
            reason: "awaiting_approval",
            payload: { tool_use_id: use.id, name: use.name, input: use.input },
          };
        }

        const idem = idempotencyKey(runId, use.id);
        const existing = await findExistingToolCall(pool, runId, idem);
        let result: ToolResult;
        if (existing?.result) {
          log.debug({ tool: use.name, idem }, "tool call deduped");
          result = existing.result;
        } else {
          await recordToolCall(pool, {
            id: use.id,
            runId,
            name: use.name,
            input: use.input,
            idempotencyKey: idem,
          });
          await setToolCallStatus(pool, use.id, "running", { startedAt: new Date() });
          const callRecord: ToolCall = {
            id: use.id,
            runId,
            name: use.name,
            input: use.input,
            idempotencyKey: idem,
            createdAt: new Date(),
          };
          await hooks.onToolCall?.(callRecord);
          const start = Date.now();
          let raw: { content: string; isError?: boolean };
          try {
            raw = await handler.invoke(use, signal, log);
          } catch (err) {
            raw = {
              content: `tool error: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
          const trunc = truncateResult(raw.content, use.id);
          result = {
            toolCallId: use.id,
            runId,
            content: raw.content,
            truncatedContent: trunc.truncated,
            tokenCount: trunc.fullTokens,
            isError: raw.isError ?? false,
            durationMs: Date.now() - start,
            createdAt: new Date(),
          };
          await recordToolResult(pool, result);
          await hooks.onToolResult?.(result);
        }
        cursor.toolCalls += 1;
        toolCallsThisStep += 1;
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: result.truncatedContent,
          ...(result.isError ? { is_error: true } : {}),
        });
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
// Helpers
// --------------------------------------------------------------------

interface NormalizedHandler {
  source: "local" | "mcp";
  invoke: (
    use: ToolUseBlock,
    signal: AbortSignal,
    logger: Logger,
  ) => Promise<{ content: string; isError?: boolean }>;
}

function findHandler(
  name: string,
  local: LocalToolHandler[],
  mcp: McpToolHandle[],
  runId: RunId,
): NormalizedHandler | null {
  const localHit = local.find((t) => t.definition.name === name);
  if (localHit) {
    return {
      source: "local",
      invoke: async (use, signal, logger) => {
        const res = await localHit.handler({
          input: use.input,
          runId,
          toolCallId: use.id,
          signal,
          logger,
        });
        return res;
      },
    };
  }
  const mcpHit = mcp.find((t) => t.exposedName === name);
  if (mcpHit) {
    return {
      source: "mcp",
      invoke: async (use, signal) => {
        const res = await mcpHit.call(use.input, signal);
        return { content: res.content, isError: res.isError };
      },
    };
  }
  return null;
}

function collectToolUses(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

function requiresApproval(toolName: string, agent: AgentDefinition): boolean {
  return agent.permissions?.requireApproval?.includes(toolName) ?? false;
}

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

function serializeError(err: unknown): {
  name: string;
  message: string;
  stack?: string;
  code?: string;
} {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  return { name: "UnknownError", message: String(err) };
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
