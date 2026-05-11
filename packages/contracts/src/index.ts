/**
 * Shared type contracts between the harness server (`@render-harness/core`,
 * `@render-harness/web`) and the browser SPA (`@render-harness/ui`).
 *
 * Two categories of types live here:
 *
 *   - Pure shapes that are identical on both sides of the wire (role
 *     strings, content blocks, token counts) — kept in one place so the
 *     browser doesn't need its own redeclaration.
 *
 *   - Wire types — the JSON shape of HTTP / SSE payloads with dates as
 *     ISO strings and optional fields as `T | null`. The server's response
 *     serializers should be typed against these so the browser's
 *     expectations are compile-time enforced from one place.
 *
 * Zero runtime, zero Node-only deps; safe to import from a browser bundle.
 */

// --------------------------------------------------------------------
// Identifiers
// --------------------------------------------------------------------

export type RunId = string;
export type ToolCallId = string;
export type MessageId = string;
export type UserId = string;
export type ConversationId = string;

// --------------------------------------------------------------------
// Messages and content blocks
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

// --------------------------------------------------------------------
// Tokens, cost, permissions
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

export interface Budget {
  maxIterations: number;
  maxWallSeconds: number;
  maxTokens: number;
  maxCostUsd: number;
}

export interface SamplingParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface Permissions {
  /** Tools that require human approval before execution. */
  requireApproval?: string[];
  /** Tools the agent is allowed to call. Empty = all registered tools. */
  allowedTools?: string[];
  /** Tools the agent is explicitly forbidden from calling. */
  deniedTools?: string[];
}

// --------------------------------------------------------------------
// Run state
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

// --------------------------------------------------------------------
// Wire types: HTTP/JSON shapes (dates serialize as ISO strings)
// --------------------------------------------------------------------

/**
 * Wire shape of an `AgentRun` row. Dates are ISO strings; `userId` and the
 * lifecycle timestamps surface as nulls instead of `undefined` because
 * JSON.stringify drops `undefined` and the client treats absence as null.
 */
export interface RunSummary {
  id: RunId;
  agentName: string;
  agentVersion: string;
  status: RunStatus;
  userId: UserId | null;
  conversationId: ConversationId | null;
  totalCostUsd: number;
  cursor: RunCursor;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Wire shape of an `AgentConversation` row. Dates are ISO strings;
 * `userId` and `title` surface as `null` when absent.
 */
export interface ConversationSummary {
  id: ConversationId;
  userId: UserId | null;
  agentName: string;
  agentVersion: string;
  title: string | null;
  totalCostUsd: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

export interface MessageRecord {
  id: MessageId;
  role: MessageRole;
  content: ContentBlock[];
  createdAt: string;
  /** Per-turn token usage; absent for system / user messages. */
  usage?: TokenUsage;
}

export interface ToolCallRecord {
  id: ToolCallId;
  name: string;
  input: unknown;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  idempotencyKey: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: ToolResultRecord | null;
}

export interface ToolResultRecord {
  content: string;
  truncatedContent: string;
  tokenCount: number;
  isError: boolean;
  durationMs: number;
  createdAt: string;
}

export interface AgentSummary {
  name: string;
  version: string;
  model: { provider: string; model: string };
  systemPromptPreview: string;
  systemPromptLength: number;
  mcpServers: { name: string; transport: "stdio" | "http" }[];
  permissions: {
    allowedTools?: string[];
    deniedTools?: string[];
    requireApproval?: string[];
  };
  budget?: Partial<Budget>;
  sampling?: SamplingParams;
  hasLocalTools: boolean;
  hasSkills: boolean;
  /** Builtin tools registered for this agent given the current process env. */
  builtinsRegistered?: string[];
  /** Builtins that would otherwise register but are skipped (env or perms). */
  builtinsSkipped?: SkippedBuiltinSummary[];
  /** Capability pack names declared on the agent. */
  capabilityPacks?: string[];
}

export interface SkippedBuiltinSummary {
  name: string;
  reason: string;
}

/**
 * Outcome of a single diagnostic check. The operator UI groups by
 * `level`, surfaces "error" entries as a top banner, and renders the full
 * list in a Diagnostics panel.
 */
export interface DiagnosticCheck {
  id: string;
  level: "ok" | "warn" | "error";
  title: string;
  message: string;
  /** Optional one-line action a human can take to fix the issue. */
  hint?: string;
}

export interface UsageRow {
  day: string;
  agentName: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

// --------------------------------------------------------------------
// Endpoint envelopes
// --------------------------------------------------------------------

export interface ListRunsResp {
  runs: RunSummary[];
  nextCursor: string | null;
}

export interface RunDetailResp {
  run: RunSummary;
  messages: MessageRecord[];
}

export interface ListConversationsResp {
  conversations: ConversationSummary[];
  nextCursor: string | null;
}

export interface ConversationDetailResp {
  conversation: ConversationSummary;
  runs: RunSummary[];
  messages: MessageRecord[];
}

export interface CreateConversationBody {
  agentName?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateConversationResp {
  conversation: ConversationSummary;
}

export interface SendConversationMessageBody {
  input: string;
  metadata?: Record<string, unknown>;
}

export interface SendConversationMessageResp {
  conversationId: ConversationId;
  runId: RunId;
  status: RunStatus;
}

export interface ToolCallsResp {
  toolCalls: ToolCallRecord[];
}

export interface AgentsResp {
  agents: AgentSummary[];
}

export interface DiagnosticsResp {
  checks: DiagnosticCheck[];
}

export interface UsageResp {
  rollups: UsageRow[];
}

export interface CreateRunBody {
  input: string;
  agentName?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateRunResp {
  runId: RunId;
  status: RunStatus;
}

export interface CancelRunResp {
  runId: RunId;
  cancelRequested: boolean;
  status: RunStatus;
  message?: string;
}

export interface SendInputResp {
  runId: RunId;
  status: RunStatus;
}

export interface HealthInfo {
  ok: boolean;
  queue: string;
  agents: string[];
  /** ISO timestamp captured when the web service process started. */
  bootedAt: string;
}
