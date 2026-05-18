/**
 * Named steps of the runAgent loop, extracted so the driver in `loop.ts`
 * stays a thin orchestrator and each step is independently testable.
 *
 * The driver decides *when* to call these — control flow stays in
 * `runAgent` — but the *what* (resume detection, tool dispatch, the
 * approval and ask_user pause shapes, the chat-vs-single-turn finish)
 * lives here.
 */

import type { Pool } from "pg";
import type { Logger } from "pino";
import { AwaitingInputError } from "./builtins/index.js";
import type { SecretsContext } from "./connections.js";
import { idempotencyKey } from "./idempotency.js";
import type { McpToolHandle } from "./mcp.js";
import {
  appendMessage,
  findExistingToolCall,
  mergeRunMetadata,
  recordToolCall,
  recordToolResult,
  setRunStatus,
  setToolCallStatus,
} from "./state/repo.js";
import { truncateResult } from "./truncate.js";
import type {
  AgentDefinition,
  ContentBlock,
  ConversationId,
  LocalToolHandler,
  Message,
  RunId,
  RunStepResult,
  RuntimeHooks,
  ToolCall,
  ToolResult,
  ToolUseBlock,
  UserId,
} from "./types.js";

// --------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------

export interface PendingToolUses {
  assistantMessage: Message;
  assistantContent: ContentBlock[];
  toolUses: ToolUseBlock[];
}

/**
 * If the most recent persisted assistant message has tool_use blocks that
 * weren't resolved by a subsequent tool message, return them so the loop
 * can dispatch directly without re-prompting the model.
 *
 * Sending an unfulfilled assistant turn back to the provider's
 * messages.create would 400 (Anthropic) or burn tokens (OpenAI), so the
 * resume detector has to run before any model call. Returns null in the
 * normal case (no pending tool uses, or last message is a tool/user
 * message that resolved the last assistant turn).
 */
export function replayPendingToolUses(messages: Message[]): PendingToolUses | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "assistant") {
      const toolUses = msg.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) return null;
      const fulfilledIds = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j];
        if (!next) continue;
        for (const block of next.content) {
          if (block.type === "tool_result") fulfilledIds.add(block.tool_use_id);
        }
      }
      const unfulfilled = toolUses.filter((t) => !fulfilledIds.has(t.id));
      if (unfulfilled.length === 0) return null;
      return {
        assistantMessage: msg,
        assistantContent: msg.content,
        toolUses: unfulfilled,
      };
    }
  }
  return null;
}

export function collectToolUses(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function requiresApproval(toolName: string, agent: AgentDefinition): boolean {
  return agent.permissions?.requireApproval?.includes(toolName) ?? false;
}

/**
 * Render the placeholder tool_result content for an `ask_user` invocation
 * that paused the run. The model never sees this — but if the agent
 * resumes after the user replies, the tool_result is already on record so
 * Anthropic's API doesn't 400 on the unfulfilled tool_use.
 */
export function formatAwaitingInputPlaceholder(payload: {
  question: string;
  options?: string[];
}): string {
  const options =
    payload.options && payload.options.length > 0
      ? `\nOptions: ${payload.options.map((o, i) => `${i + 1}. ${o}`).join(" | ")}`
      : "";
  return [
    "Awaiting user input.",
    `Question: ${payload.question}`,
    options.trim(),
    "The user's reply will arrive as the next user message.",
  ]
    .filter(Boolean)
    .join("\n");
}

interface NormalizedHandler {
  source: "local" | "mcp";
  invoke: (
    use: ToolUseBlock,
    signal: AbortSignal,
    logger: Logger,
  ) => Promise<{ content: string; isError?: boolean }>;
}

export interface FindHandlerArgs {
  name: string;
  local: LocalToolHandler[];
  mcp: McpToolHandle[];
  runId: RunId;
  userId: UserId | null;
  secrets?: SecretsContext;
}

export function findHandler(args: FindHandlerArgs): NormalizedHandler | null {
  const { name, local, mcp, runId, userId, secrets } = args;
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
          userId,
          ...(secrets ? { secrets } : {}),
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

// --------------------------------------------------------------------
// Pause shapes (paused: awaiting_approval, awaiting_input — HITL only)
// --------------------------------------------------------------------

export async function pauseForApproval(args: {
  pool: Pool;
  runId: RunId;
  use: ToolUseBlock;
  logger: Logger;
}): Promise<RunStepResult> {
  const { pool, runId, use, logger } = args;
  // Persist pause shape into agent_runs.metadata so callers (operator UI,
  // worker re-enqueue logic, integration tests) can read which tool_use_id
  // is waiting for approval without re-walking the message log. Mirrors the
  // `awaiting_input` pattern in pauseForAwaitingInput.
  await mergeRunMetadata(pool, runId, {
    pauseReason: "awaiting_approval",
    awaitingApproval: { tool_use_id: use.id, name: use.name, input: use.input },
  });
  await setRunStatus(pool, runId, "paused");
  logger.info({ tool: use.name, toolUseId: use.id }, "paused: awaiting_approval");
  return {
    status: "paused",
    reason: "awaiting_approval",
    payload: { tool_use_id: use.id, name: use.name, input: use.input },
  };
}

export async function pauseForAwaitingInput(args: {
  pool: Pool;
  runId: RunId;
  conversationId: ConversationId | null;
  use: ToolUseBlock;
  payload: { question: string; options?: string[] };
  hooks: RuntimeHooks;
  logger: Logger;
  /** Wall-clock the handler ran before throwing AwaitingInputError. */
  startMs: number;
}): Promise<RunStepResult> {
  const { pool, runId, conversationId, use, payload, hooks, logger, startMs } = args;

  // Fulfill the dangling tool_use with a placeholder result so the resume
  // path doesn't try to re-invoke ask_user. The user's actual answer
  // arrives as the next user message via POST /runs/:id/input and gets
  // fed to the model on the next turn.
  const placeholder = formatAwaitingInputPlaceholder(payload);
  const trunc = truncateResult(placeholder, use.id);
  const placeholderResult: ToolResult = {
    toolCallId: use.id,
    runId,
    content: placeholder,
    truncatedContent: trunc.truncated,
    tokenCount: trunc.fullTokens,
    isError: false,
    durationMs: Date.now() - startMs,
    createdAt: new Date(),
  };
  await recordToolResult(pool, placeholderResult);
  await hooks.onToolResult?.(placeholderResult);

  const toolMsg = await appendMessage(pool, {
    runId,
    conversationId,
    role: "tool",
    content: [
      {
        type: "tool_result",
        tool_use_id: use.id,
        content: placeholderResult.truncatedContent,
      },
    ],
  });
  await hooks.onMessage?.(toolMsg);

  await mergeRunMetadata(pool, runId, {
    pauseReason: "awaiting_input",
    askUser: { ...payload, tool_use_id: use.id },
  });
  await setRunStatus(pool, runId, "paused");
  logger.info({ tool: use.name, toolUseId: use.id }, "paused: awaiting_input from ask_user");

  return {
    status: "paused",
    reason: "awaiting_input",
    payload: { ...payload, tool_use_id: use.id },
  };
}

/**
 * Called when the model returns an assistant turn with no tool_use blocks
 * — i.e. a final answer. The run always completes; multi-turn behaviour is
 * driven by enqueueing a *new* run on the same `conversationId` rather than
 * pausing this one.
 */
export async function finishWithoutToolCalls(args: {
  pool: Pool;
  runId: RunId;
  assistant: Message;
}): Promise<RunStepResult> {
  const { pool, runId, assistant } = args;
  await setRunStatus(pool, runId, "completed");
  return { status: "completed", finalMessage: assistant };
}

// --------------------------------------------------------------------
// Tool execution (the body of the inner for-loop in runAgent)
// --------------------------------------------------------------------

export interface ToolExecutionContext {
  pool: Pool;
  logger: Logger;
  hooks: RuntimeHooks;
  runId: RunId;
  /**
   * The conversation this run belongs to, or null for single-turn / cron
   * one-shot runs. Threaded through so `pauseForAwaitingInput`'s persisted
   * placeholder tool_result message carries the same `conversation_id` as
   * every other message on this run.
   */
  conversationId: ConversationId | null;
  signal: AbortSignal;
  agentDef: AgentDefinition;
  localTools: LocalToolHandler[];
  mcpTools: McpToolHandle[];
  approvedToolCallIds?: ReadonlySet<string>;
  /** Owner of this run; threaded into pack tool handlers as `args.userId`. */
  userId: UserId | null;
  /**
   * Per-end-user OAuth connection accessor (see
   * `@render-harness/core/src/connections.ts`). Constructed once per
   * `runAgent` invocation and threaded into every local-tool handler.
   * `undefined` means the runtime opted out of the connection API.
   */
  secrets?: SecretsContext;
}

/**
 * Outcome of dispatching a single tool_use block. The driver either appends
 * `block` to the batch of tool_result blocks (and continues the inner loop)
 * or returns `result` directly to the runtime to short-circuit the run.
 */
export type ExecutedToolCall =
  | { kind: "result"; block: ContentBlock }
  | { kind: "paused"; result: RunStepResult };

/**
 * Dispatch one tool_use:
 *   - resolve handler (local tools + MCP)
 *   - apply per-agent approval gate (may pause)
 *   - dedup by idempotency key (run + tool_use_id)
 *   - record call + result rows, fire hooks
 *   - translate AwaitingInputError into a pause shape
 *
 * Returns a result block to fold into the assistant's tool_result message,
 * or a paused RunStepResult that the driver propagates as-is.
 */
export async function executeToolCall(
  ctx: ToolExecutionContext,
  use: ToolUseBlock,
): Promise<ExecutedToolCall> {
  const {
    pool,
    logger,
    hooks,
    runId,
    conversationId,
    signal,
    agentDef,
    localTools,
    mcpTools,
    approvedToolCallIds,
    userId,
    secrets,
  } = ctx;

  const handler = findHandler({
    name: use.name,
    local: localTools,
    mcp: mcpTools,
    runId,
    userId,
    ...(secrets ? { secrets } : {}),
  });
  if (!handler) {
    return {
      kind: "result",
      block: {
        type: "tool_result",
        tool_use_id: use.id,
        content: `tool "${use.name}" is not registered for this agent`,
        is_error: true,
      },
    };
  }

  if (requiresApproval(use.name, agentDef) && !approvedToolCallIds?.has(use.id)) {
    return { kind: "paused", result: await pauseForApproval({ pool, runId, use, logger }) };
  }

  const idem = idempotencyKey(runId, use.id);
  const existing = await findExistingToolCall(pool, runId, idem);
  let result: ToolResult;

  if (existing?.result) {
    logger.debug({ tool: use.name, idem }, "tool call deduped");
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
      raw = await handler.invoke(use, signal, logger);
    } catch (err) {
      if (err instanceof AwaitingInputError) {
        return {
          kind: "paused",
          result: await pauseForAwaitingInput({
            pool,
            runId,
            conversationId,
            use,
            payload: err.payload,
            hooks,
            logger,
            startMs: start,
          }),
        };
      }
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

  return {
    kind: "result",
    block: {
      type: "tool_result",
      tool_use_id: use.id,
      content: result.truncatedContent,
      ...(result.isError ? { is_error: true } : {}),
    },
  };
}
