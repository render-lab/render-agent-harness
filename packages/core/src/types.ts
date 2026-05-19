/**
 * Core type contract for the Render agent harness.
 *
 * Every runtime (cron, worker, workflows) calls into the core via {@link runAgent}
 * with an {@link AgentDefinition} and a {@link CheckpointPolicy}. The core owns the
 * loop, the model adapter, MCP, state, skills, prompts, idempotency, and
 * cancellation. Runtimes never read message history or call the model directly.
 *
 * Browser-safe primitives (RunStatus, ContentBlock, TokenUsage, etc.) live
 * in `@render-harness/contracts` and are re-exported here so existing
 * consumers of `@render-harness/core` keep working unchanged.
 */

import type {
  Budget,
  ContentBlock,
  ConversationId,
  MessageId,
  MessageRole,
  Permissions,
  RunCursor,
  RunId,
  RunStatus,
  SamplingParams,
  ScheduleId,
  TokenUsage,
  ToolCallId,
  UserId,
} from "@render-harness/contracts";
import type { Logger } from "pino";
import type { SecretsContext } from "./connections.js";
import type { PackMigration } from "./state/schema.js";

// --------------------------------------------------------------------
// Re-exports from @render-harness/contracts
// --------------------------------------------------------------------

export type {
  Budget,
  ContentBlock,
  ConversationId,
  CostEstimate,
  MessageId,
  MessageRole,
  Permissions,
  RunCursor,
  RunId,
  RunStatus,
  SamplingParams,
  ScheduleId,
  TextBlock,
  ThinkingBlock,
  TokenUsage,
  ToolCallId,
  ToolResultBlock,
  ToolUseBlock,
  UserId,
} from "@render-harness/contracts";

// --------------------------------------------------------------------
// Messages (runtime form: Date instead of ISO string)
// --------------------------------------------------------------------

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
// Run lifecycle (runtime form — wire form lives in @render-harness/contracts)
// --------------------------------------------------------------------

export interface AgentRun {
  id: RunId;
  agentName: string;
  agentVersion: string;
  status: RunStatus;
  userId: UserId | null;
  /**
   * When set, this run belongs to a multi-turn conversation. The loop loads
   * message history across every run in the conversation (not just this one)
   * and updates `agent_conversations.last_active_at` / `total_cost_usd` on
   * terminal transitions.
   */
  conversationId: ConversationId | null;
  cursor: RunCursor;
  totalCostUsd: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  /** Free-form metadata supplied at run creation. */
  metadata: Record<string, unknown>;
}

/**
 * Runtime form of an `agent_conversations` row. Groups many runs into one
 * ongoing thread. Created up front; new user turns enqueue runs that always
 * end in a terminal state.
 */
export interface AgentConversation {
  id: ConversationId;
  userId: UserId | null;
  agentName: string;
  agentVersion: string;
  title: string | null;
  metadata: Record<string, unknown>;
  totalCostUsd: number;
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date;
}

export type NotificationKind = "slack" | "webhook" | "inbox";

export interface NotificationConfig {
  kind: NotificationKind;
  target: string | null;
}

export interface Schedule {
  id: ScheduleId;
  userId: UserId;
  agentName: string;
  input: string;
  metadata: Record<string, unknown>;
  cronExpr: string;
  timezone: string;
  notifications: NotificationConfig[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastFiredAt?: Date;
  nextFireAt?: Date;
}

export interface ScheduleRun {
  scheduleId: ScheduleId;
  runId: RunId;
  firedAt: Date;
}

export interface NotificationDelivery {
  id: string;
  runId: RunId;
  scheduleId: ScheduleId | null;
  userId: UserId;
  kind: NotificationKind;
  target: string | null;
  summary: string;
  status: "delivered" | "failed";
  error: string | null;
  createdAt: Date;
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
      reason: "awaiting_input" | "awaiting_approval";
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
   * Pack-contributed SQL migrations collected by `defineFromConfig`
   * from every capability pack's `migrations` slot. The runtime
   * adapter applies these at boot via
   * `applyMigrations(pool, { packMigrations: agent.packMigrations })`,
   * after core migrations and under the same advisory lock. Dedup is
   * by `(packName, id)` — passing the same migration twice (because
   * two agents in a bundle use the same pack) is a no-op.
   */
  packMigrations?: PackMigration[];
  /**
   * Names of capability packs the agent has been composed with — declarative
   * metadata only; the harness doesn't read this for behavior. The operator
   * UI's Guide tab surfaces it so an operator can see, at a glance, which
   * capability packs (e.g. `@render-harness/cap-search-exa`,
   * `@render-harness/cap-memory-pg`) the deployed agent uses.
   */
  capabilityPacks?: string[];
  /**
   * Where this agent originated. Populated by `defineFromConfig`:
   *
   *  - `{ kind: "builtin" }` — the YAML used `agent: { kind: builtin, ref: chat,
   *    systemPrompt: ... }`. The system prompt lives directly in
   *    `render-harness.yaml` and is safe for the operator UI to edit-in-place
   *    via `PATCH /agents/:slug/system-prompt`.
   *  - `{ kind: "custom", entrypoint }` — the YAML referenced a TS module.
   *    The system prompt is whatever that module exports; editing it from
   *    the UI would require rewriting source code, so the operator UI
   *    shows a read-only preview plus a pointer to `entrypoint`.
   *
   * Unset when the AgentDefinition was constructed by hand (no YAML), e.g.
   * `serveWeb({ agent: defineAgent({ ... }) })`. The UI treats undefined
   * the same as `kind: "custom"` (not editable in-place).
   */
  source?: AgentSource;
}

export type AgentSource = { kind: "builtin" } | { kind: "custom"; entrypoint: string };

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

export interface LocalToolHandler {
  definition: ToolDefinition;
  handler: (args: {
    input: unknown;
    runId: RunId;
    toolCallId: ToolCallId;
    signal: AbortSignal;
    logger: Logger;
    /**
     * The owner of the run this tool is executing under, or null when
     * the runtime didn't attach one. Pack tools that need per-end-user
     * data should branch on this; the platform already scopes
     * `secrets` to the same userId so most packs only need to call
     * `secrets?.requireConnection(...)`.
     */
    userId?: UserId | null;
    /**
     * Per-end-user OAuth connections (see `@render-harness/core`'s
     * `connections.ts`). `undefined` means the runtime opted out of
     * mounting the connection API — packs should treat that as "no
     * connections available" rather than crashing.
     */
    secrets?: SecretsContext;
  }) => Promise<{ content: string; isError?: boolean }>;
}
