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
export type ScheduleId = string;

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
  /**
   * When `status === "paused"`, describes what the run is waiting on so the
   * operator UI knows whether to render a text input (`ask_user`) or an
   * Approve/Reject affordance (`requireApproval`). Derived from
   * `metadata.pauseReason` / `metadata.askUser` / `metadata.awaitingApproval`
   * by the serializer; consumers should branch on `pause.reason` rather than
   * poking into `metadata` directly.
   */
  pause: RunPauseInfo | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Human-in-the-loop pause shape. Either the agent called the `ask_user`
 * builtin and is waiting for a text answer, or the agent attempted a tool
 * in `permissions.requireApproval` and is waiting for an explicit approval
 * by `tool_use_id`.
 */
export type RunPauseInfo =
  | {
      reason: "awaiting_input";
      payload: { question: string; options?: string[]; tool_use_id: string };
    }
  | {
      reason: "awaiting_approval";
      payload: { tool_use_id: string; name: string; input: unknown };
    };

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
  /** Agent id from `render-harness.yaml` (also lands in agent_runs rows). */
  agentId: string;
  model: AgentModelSummary;
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
 * Model spec surfaced by `GET /agents`. Mirrors `ModelSpecInput` from
 * `@render-harness/registry/schema` but lives in `contracts` so the SPA
 * doesn't pull in zod.
 */
export interface AgentModelSummary {
  provider: "anthropic" | "openai-compat";
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
  thinking?: { enabled: true; budgetTokens: number };
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

export type VitalsMetricKind = "cpu" | "memory" | "httpLatencyP95";

export interface VitalsMetricPoint {
  timestamp: string;
  value: number;
}

export interface VitalsMetricSeries {
  kind: VitalsMetricKind;
  label: string;
  unit: "percent" | "bytes" | "milliseconds";
  points: VitalsMetricPoint[];
}

export interface VitalsInstance {
  id: string;
  name: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * One sibling Render service in the harness deployment. The Vitals tab
 * lists them so operators can switch between the web / worker / cron
 * (and any other) services that share an environment.
 *
 * `type` mirrors Render API's `serviceType` enum (`web_service`,
 * `background_worker`, `cron_job`, `private_service`, `static_site`).
 * `suspended` is the literal Render value (`"suspended"` /
 * `"not_suspended"`), surfaced verbatim so the UI can render a badge
 * without inventing a third state.
 */
export interface VitalsServiceSummary {
  serviceId: string;
  name: string;
  type: string | null;
  suspended: string | null;
  dashboardUrl: string | null;
  environmentId: string | null;
  /** True for the service hosting the operator UI itself. */
  isCurrent: boolean;
}

export interface VitalsLogEntry {
  id: string;
  timestamp: string;
  message: string;
  level: string | null;
  type: string | null;
  resource: string | null;
  instance: string | null;
  method: string | null;
  path: string | null;
  statusCode: string | null;
}

// --------------------------------------------------------------------
// Scheduled runs
// --------------------------------------------------------------------

export type NotificationKind = "slack" | "webhook" | "inbox";

export interface NotificationConfig {
  kind: NotificationKind;
  target: string | null;
}

export interface ScheduleSummary {
  id: ScheduleId;
  userId: UserId;
  agentName: string;
  input: string;
  metadata: Record<string, unknown>;
  cronExpr: string;
  timezone: string;
  notifications: NotificationConfig[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  nextFireAt: string | null;
}

export interface ScheduleHistoryItem {
  scheduleId: ScheduleId;
  run: RunSummary;
  firedAt: string;
  summary: string | null;
}

export interface InboxItem {
  id: string;
  scheduleId: ScheduleId | null;
  runId: RunId;
  userId: UserId;
  kind: NotificationKind;
  target: string | null;
  summary: string;
  status: "delivered" | "failed";
  error: string | null;
  createdAt: string;
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

export interface CapabilitySummary {
  pack: string;
  agents: string[];
  localToolCount: number;
  mcpServerCount: number;
  envVars: DeploymentEnvVar[];
}

export interface CapabilitiesResp {
  capabilities: CapabilitySummary[];
}

export interface ConnectorSummary {
  key: string;
  pack: string;
  url: string;
}

export interface ConnectorsResp {
  connectors: ConnectorSummary[];
}

// --------------------------------------------------------------------
// Per-end-user OAuth connections (cap-google, cap-microsoft, etc.)
// --------------------------------------------------------------------

/**
 * Wire shape of an `agent_user_connections` row. Dates serialize as
 * ISO strings; `accountLabel` surfaces as `null` when the provider's
 * userinfo fetch didn't yield one.
 */
export interface UserConnectionSummary {
  provider: string;
  displayName: string;
  scopes: string[];
  accountLabel: string | null;
  connectedAt: string;
  updatedAt: string;
  expiresAt: string;
}

/**
 * One installable provider as seen by the operator UI. The Connections
 * tab renders one entry per provider, with a "Connect" button when no
 * `connection` row matches and "Disconnect" / "Reconnect" when it does.
 *
 * `requiredBy` lists the capability packs whose tools call
 * `secrets.requireConnection(provider)` so the UI can explain *why*
 * the user should connect.
 */
export interface ConnectionProviderSummary {
  id: string;
  displayName: string;
  defaultScopes: string[];
  clientCredentialsConfigured: boolean;
  requiredBy: string[];
}

export interface ConnectionsResp {
  /** Providers the deployment knows about (installed packs + env-configured). */
  providers: ConnectionProviderSummary[];
  /** Connections the *current user* has established. */
  connections: UserConnectionSummary[];
}

export interface StartConnectionResp {
  /** Provider's authorize URL. The SPA navigates to it directly. */
  authorizeUrl: string;
  /** Provider id the start was for, echoed for caller convenience. */
  provider: string;
}

export interface DeleteConnectionResp {
  ok: boolean;
  provider: string;
}

/**
 * Deployment-wide metadata exposed at GET /deployment. Drives the operator
 * UI's header label and the in-product Guide so prose, service names, and
 * code excerpts reflect the actual running bundle instead of literal
 * "operator-demo" placeholders.
 *
 * `agents[].runtimes` is the resolved trigger set (web / worker / cron /
 * workflows) for that agent — same shape the YAML manifest declares.
 * `agents[].workflowTask` is the effective bit (true if any cron is
 * via:workflow, or `kind: workflows`, or explicitly flagged).
 *
 * `description`, `bundleSlug`, and `capabilityPacks` may be absent for
 * single-agent / hand-rolled deployments that didn't supply them.
 */
export interface DeploymentInfo {
  name: string;
  description?: string;
  bundleSlug?: string;
  agents: DeploymentAgentInfo[];
  capabilityPacks?: string[];
  /** Declared and running harness package versions for compatibility warnings. */
  harness?: HarnessVersionInfo;
  /**
   * Origin of the wizard service that owns the GitHub App credentials
   * for in-UI edits (e.g. model changes). When absent, the operator UI
   * hides edit affordances. Populated from `RENDER_HARNESS_WIZARD_URL`
   * at deploy time.
   */
  wizardServiceUrl?: string;
  /**
   * Where the deployed bundle was scaffolded from. Read from
   * `.render-harness/agent.json` at boot. `installationId` is null for
   * CLI-scaffolded repos until the user installs the render-harness
   * GitHub App on their own repo via the wizard's install flow.
   *
   * `repoSshUrl` is derived from `org` + `repo` at boot and is the
   * target the harness clones + pushes to when committing edit-in-UI
   * changes via the deploy-key path (paired with `GITHUB_DEPLOY_KEY`
   * in env). Absent when `org` or `repo` is missing.
   */
  repoLocator?: {
    org: string | null;
    repo: string | null;
    installationId: string | null;
    repoSshUrl?: string | null;
  };
  /**
   * Merged env-var requirements (from `config.envSchema` + each
   * capability pack's `envSchema`), annotated with whether the
   * variable is currently set in `process.env` of the running worker.
   * Drives the Config tab.
   */
  envSchema?: DeploymentEnvVar[];
  /**
   * Render-side service identity needed to mutate env vars via the
   * Render API. `serviceId` is auto-injected by Render at runtime;
   * when absent (local dev), in-UI env-var writes are disabled.
   */
  renderService?: {
    serviceId: string | null;
    /** Whether `RENDER_API_KEY` is set on this service. */
    apiKeyConfigured: boolean;
  };
  /**
   * Optional operator UI feature flags. These gate high-privilege or
   * Render-API-backed UI surfaces without exposing secrets to the browser.
   */
  operatorFeatures?: {
    vitals: {
      enabled: boolean;
      missing: string[];
    };
  };
}

export type HarnessCompatibilityStatus = "ok" | "warning" | "incompatible" | "unknown";

export interface HarnessVersionInfo {
  /** The manifest's declared harness range, from render-harness.yaml. */
  declaredRange: string | null;
  /** Best-effort versions of loaded first-party harness packages. */
  running: Record<string, string>;
  /** Overall compatibility summary for the running deployment. */
  status: HarnessCompatibilityStatus;
  /** Human-readable warnings, safe to show in UI and Diagnostics. */
  messages: string[];
}

/**
 * One env-var requirement surfaced by `GET /deployment`. Mirrors
 * `EnvVarSpec` in the registry schema plus an `isSet` flag the SPA
 * uses to render status pills.
 */
export interface DeploymentEnvVar {
  name: string;
  required: boolean;
  secret: boolean;
  description?: string;
  default?: string;
  isSet: boolean;
  /** Where the spec came from (helps the UI explain why a var is required). */
  source: "harness" | "capability";
  /** When source = "capability", the pack name. */
  packName?: string;
}

export interface DeploymentAgentInfo {
  id: string;
  name: string;
  runtimes: DeploymentAgentRuntime[];
  workflowTask: boolean;
}

export type DeploymentAgentRuntime =
  | { kind: "web" }
  | { kind: "worker"; queue?: string }
  | { kind: "cron"; schedule: string; via: "cron" | "workflow" }
  | { kind: "workflows" };

export interface DiagnosticsResp {
  checks: DiagnosticCheck[];
}

export interface UsageResp {
  rollups: UsageRow[];
}

export interface VitalsResp {
  serviceId: string;
  range: {
    startTime: string;
    endTime: string;
    resolutionSeconds: number;
  };
  instances: VitalsInstance[];
  metrics: VitalsMetricSeries[];
}

export interface VitalsLogsResp {
  logs: VitalsLogEntry[];
  nextCursor: string | null;
}

export interface VitalsServicesResp {
  /** Sibling services found in the same Render environment as this deployment. */
  services: VitalsServiceSummary[];
  /** Service the operator UI is currently running on. */
  currentServiceId: string;
}

export interface ListSchedulesResp {
  schedules: ScheduleSummary[];
}

export interface ScheduleRunsResp {
  runs: ScheduleHistoryItem[];
}

export interface InboxResp {
  items: InboxItem[];
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

/**
 * Wire shape for `POST /runs/:id/input`. The endpoint distinguishes between
 * the two reasons a run can be paused:
 *
 * - `awaiting_input` (the `ask_user` builtin) — expects `{ input: string }`.
 * - `awaiting_approval` (`permissions.requireApproval`) — expects
 *   `{ approvedToolCallIds: string[] }` listing the `tool_use_id`s the
 *   operator approves to execute.
 *
 * The endpoint validates the body shape against the current pause reason
 * and returns `409 wrong_pause_reason` if they don't match.
 */
export type SendInputReq = { input: string } | { approvedToolCallIds: string[] };

export interface HealthInfo {
  ok: boolean;
  queue: string;
  agents: string[];
  /** ISO timestamp captured when the web service process started. */
  bootedAt: string;
}
