/**
 * Core type contract for the Render agent harness.
 *
 * Every runtime (cron, worker, workflows) calls into the core via {@link runAgent}
 * with an {@link AgentDefinition} and a {@link CheckpointPolicy}. The core owns the
 * loop, the model adapter, MCP, state, skills, prompts, idempotency, and
 * cancellation. Runtimes never read message history or call the model directly.
 */

import type { Logger } from "pino";

// --------------------------------------------------------------------
// Identifiers
// --------------------------------------------------------------------

export type RunId = string;
export type ToolCallId = string;
export type MessageId = string;
export type UserId = string;

// --------------------------------------------------------------------
// Messages
// --------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: ToolCallId;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: ToolCallId;
  content: string;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface Message {
  id: MessageId;
  role: MessageRole;
  content: ContentBlock[];
  createdAt: Date;
  /** Per-turn token usage; null for system / user messages. */
  usage?: TokenUsage;
}

// --------------------------------------------------------------------
// Tool calls and results
// --------------------------------------------------------------------

export interface ToolCall {
  id: ToolCallId;
  runId: RunId;
  name: string;
  input: unknown;
  /** Stable hash of (runId, id) used for idempotency lookups. */
  idempotencyKey: string;
  createdAt: Date;
}

export interface ToolResult {
  toolCallId: ToolCallId;
  runId: RunId;
  /** The full result payload, stored unbounded in `agent_tool_results`. */
  content: string;
  /** Approximate token count of the full content. */
  tokenCount: number;
  /** Truncated form injected back into context (defaults to first 2000 tokens). */
  truncatedContent: string;
  isError: boolean;
  durationMs: number;
  createdAt: Date;
}

// --------------------------------------------------------------------
// Tool definitions (MCP-shaped)
// --------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Source: "builtin" | "mcp:<server>" | "skill" */
  source: string;
}

// --------------------------------------------------------------------
// Token usage and cost
// --------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostEstimate {
  inputUsd: number;
  outputUsd: number;
  cacheUsd: number;
  totalUsd: number;
}

// --------------------------------------------------------------------
// Run lifecycle
// --------------------------------------------------------------------

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface RunCursor {
  /** Number of full turns (assistant messages) completed so far. */
  turn: number;
  /** Number of tool calls executed so far. */
  toolCalls: number;
  /** Cumulative wall time in ms. */
  wallMs: number;
  /** Cumulative token usage so far. */
  usage: TokenUsage;
}

export interface AgentRun {
  id: RunId;
  agentName: string;
  agentVersion: string;
  status: RunStatus;
  userId: UserId | null;
  cursor: RunCursor;
  totalCostUsd: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  /** Free-form metadata supplied at run creation. */
  metadata: Record<string, unknown>;
}

// --------------------------------------------------------------------
// Checkpoint policy
// --------------------------------------------------------------------

export type CheckpointPolicy =
  | { kind: "run-to-completion" }
  | { kind: "every-tool-call" }
  | {
      kind: "soft";
      maxToolCalls: number;
      maxSeconds: number;
    };

export const DEFAULT_SOFT_CHECKPOINT: CheckpointPolicy = {
  kind: "soft",
  maxToolCalls: 25,
  // Stays comfortably inside the default 7200s Workflows task timeout.
  maxSeconds: 6000,
};

// --------------------------------------------------------------------
// Run step result (what runAgent returns)
// --------------------------------------------------------------------

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  /** Optional structured error code (e.g. "rate_limited", "context_overflow"). */
  code?: string;
}

export type RunStepResult =
  | { status: "completed"; finalMessage: Message }
  | {
      status: "paused";
      reason: "awaiting_input" | "awaiting_approval" | "chat_turn_end";
      payload: unknown;
    }
  | { status: "checkpoint"; cursor: RunCursor }
  | { status: "failed"; error: SerializedError }
  | { status: "cancelled" };

// --------------------------------------------------------------------
// Hooks the runtime supplies
// --------------------------------------------------------------------

export interface RuntimeHooks {
  onMessage?: (msg: Message) => void | Promise<void>;
  onToolCall?: (call: ToolCall) => void | Promise<void>;
  onToolResult?: (result: ToolResult) => void | Promise<void>;
  onTokenUsage?: (usage: TokenUsage) => void | Promise<void>;
}

// --------------------------------------------------------------------
// Budgets and stop conditions
// --------------------------------------------------------------------

export interface Budget {
  /** Hard cap on tool-loop iterations. */
  maxIterations: number;
  /** Hard cap on wall-clock seconds (the runtime can override down). */
  maxWallSeconds: number;
  /** Hard cap on combined input + output tokens for the whole run. */
  maxTokens: number;
  /** Hard cap on total cost in USD. Run terminates when crossed. */
  maxCostUsd: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxIterations: 50,
  maxWallSeconds: 11 * 60 * 60, // 11h, leaves room before the 12h cron cap
  maxTokens: 1_000_000,
  maxCostUsd: 10,
};

// --------------------------------------------------------------------
// MCP server configuration
// --------------------------------------------------------------------

export type McpServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /** Optional allowlist of tool names to expose. */
      allowTools?: string[];
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
      allowTools?: string[];
    };

// --------------------------------------------------------------------
// Skills
// --------------------------------------------------------------------

export interface SkillMetadata {
  name: string;
  description: string;
  /** When the agent should reach for this skill. Surfaced in the system prompt. */
  whenToUse: string;
  /** Path on disk where the SKILL.md content lives. */
  contentPath: string;
}

// --------------------------------------------------------------------
// Permissions
// --------------------------------------------------------------------

export interface Permissions {
  /** Tools that require human approval before execution. */
  requireApproval?: string[];
  /** Tools the agent is allowed to call. Empty = all registered tools. */
  allowedTools?: string[];
  /** Tools the agent is explicitly forbidden from calling. */
  deniedTools?: string[];
}

// --------------------------------------------------------------------
// Agent definition
// --------------------------------------------------------------------

export interface AgentDefinition {
  /** Stable identifier; persisted on every run for audit. */
  name: string;
  /** Bumped when the agent's prompt or tools change in a meaningful way. */
  version: string;
  /** Provider + model identifier passed to the LLMClient adapter. */
  model: ModelSpec;
  /** Top-level system prompt; cache-pinned by the prompt assembler. */
  systemPrompt: string;
  /** MCP servers to launch / connect for this agent. */
  mcpServers?: McpServerConfig[];
  /** Local tool definitions the agent can call directly (e.g. wrappers around Render APIs). */
  localTools?: LocalToolHandler[];
  /** Skills directory or explicit skill list. */
  skills?: { kind: "directory"; path: string } | { kind: "explicit"; skills: SkillMetadata[] };
  /** Per-agent permission overrides. */
  permissions?: Permissions;
  /** Per-agent budget overrides. */
  budget?: Partial<Budget>;
  /** Optional sampling params (temperature, top_p, etc.). */
  sampling?: SamplingParams;
  /**
   * Conversation shape. `single-turn` (default) ends each run in `completed`
   * once the model returns a final answer. `chat` keeps the run open across
   * turns: when the model returns an answer with no tool calls the loop sets
   * status to `paused` (with `metadata.pauseReason = "chat_turn_end"`) so the
   * caller can append the next user message via `POST /runs/:id/input` and
   * re-enqueue the same run. The full message history accumulates on the run
   * and is fed back to the model on every turn.
   */
  shape?: "single-turn" | "chat";
  /**
   * Names of capability packs the agent has been composed with — declarative
   * metadata only; the harness doesn't read this for behavior. The operator
   * UI's Guide tab surfaces it so an operator can see, at a glance, which
   * capability packs (e.g. `@render-harness/cap-search-exa`,
   * `@render-harness/cap-memory-pg`) the deployed agent uses.
   */
  capabilityPacks?: string[];
}

export interface ModelSpec {
  provider: "anthropic" | "openai-compat";
  /** e.g. "claude-sonnet-4-6" or "openai/gpt-4o" or "anthropic/claude-sonnet-4-6" via OpenRouter. */
  model: string;
  /** Optional baseURL override (used by the openai-compat adapter for gateways). */
  baseURL?: string;
  /** Provider API key env var name. Defaults are inferred per provider. */
  apiKeyEnv?: string;
  /** Anthropic-only: enable extended thinking. */
  thinking?: { enabled: true; budgetTokens: number };
}

export interface SamplingParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface LocalToolHandler {
  definition: ToolDefinition;
  handler: (args: {
    input: unknown;
    runId: RunId;
    toolCallId: ToolCallId;
    signal: AbortSignal;
    logger: Logger;
  }) => Promise<{ content: string; isError?: boolean }>;
}
