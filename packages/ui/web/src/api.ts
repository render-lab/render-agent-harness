/**
 * Browser-side client for the harness web service.
 *
 * Uses cookies for auth (set by the UI login route); no bearer header is needed
 * from the browser. Errors are surfaced as `ApiError` so the UI can show
 * a coherent message.
 *
 * Wire types are imported from `@render-harness/contracts` so the SPA
 * and server share one source of truth.
 */

import type {
  AgentModelSummary,
  AgentSummary,
  CancelRunResp,
  CapabilitiesResp,
  CapabilitySummary,
  ConnectorSummary,
  ConnectorsResp,
  ContentBlock,
  ConversationDetailResp,
  ConversationSummary,
  CreateConversationBody,
  CreateConversationResp,
  CreateRunBody,
  CreateRunResp,
  DeploymentAgentInfo,
  DeploymentAgentRuntime,
  DeploymentEnvVar,
  DeploymentInfo,
  DiagnosticCheck,
  HealthInfo,
  InboxItem,
  InboxResp,
  ListConversationsResp,
  ListRunsResp,
  ListSchedulesResp,
  MessageRecord,
  RunDetailResp,
  RunStatus,
  RunSummary,
  ScheduleHistoryItem,
  ScheduleRunsResp,
  ScheduleSummary,
  SendConversationMessageBody,
  SendConversationMessageResp,
  SendInputResp,
  ToolCallRecord,
  UsageRow,
  VitalsInstance,
  VitalsLogEntry,
  VitalsLogsResp,
  VitalsMetricSeries,
  VitalsResp,
} from "@render-harness/contracts";
import { uiPath } from "./lib/mount.js";

export type {
  AgentModelSummary,
  AgentSummary,
  CapabilitySummary,
  ConnectorSummary,
  ContentBlock,
  ConversationSummary,
  DeploymentAgentInfo,
  DeploymentAgentRuntime,
  DeploymentEnvVar,
  DeploymentInfo,
  DiagnosticCheck,
  HealthInfo,
  InboxItem,
  MessageRecord,
  RunStatus,
  RunSummary,
  ScheduleHistoryItem,
  ScheduleSummary,
  ToolCallRecord,
  UsageRow,
  VitalsInstance,
  VitalsLogEntry,
  VitalsMetricSeries,
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: unknown,
  ) {
    super(message);
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: "include",
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    if (res.status === 401) {
      // Bounce the user to login. The redirect flag below is read by the
      // app shell to perform a full navigation.
      window.location.href = `${uiPath("/login")}?next=${encodeURIComponent(window.location.pathname)}`;
    }
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new ApiError(message, res.status, parsed);
  }
  return parsed as T;
}

// --------------------------------------------------------------------
// Endpoints
// --------------------------------------------------------------------

export interface ListRunsParams {
  status?: RunStatus[];
  agent?: string[];
  limit?: number;
  cursor?: string;
  allUsers?: boolean;
}

export function listRuns(params: ListRunsParams = {}): Promise<ListRunsResp> {
  const usp = new URLSearchParams();
  for (const s of params.status ?? []) usp.append("status", s);
  for (const a of params.agent ?? []) usp.append("agent", a);
  if (params.limit) usp.set("limit", String(params.limit));
  if (params.cursor) usp.set("cursor", params.cursor);
  if (params.allUsers) usp.set("allUsers", "1");
  const qs = usp.toString();
  return request<ListRunsResp>(`/runs${qs ? `?${qs}` : ""}`);
}

export function createRun(body: CreateRunBody): Promise<CreateRunResp> {
  return request<CreateRunResp>("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getRun(id: string): Promise<RunDetailResp> {
  return request<RunDetailResp>(`/runs/${encodeURIComponent(id)}`);
}

// --------------------------------------------------------------------
// Conversations
// --------------------------------------------------------------------

export interface ListConversationsParams {
  agent?: string[];
  limit?: number;
  cursor?: string;
  allUsers?: boolean;
}

export function listConversations(
  params: ListConversationsParams = {},
): Promise<ListConversationsResp> {
  const usp = new URLSearchParams();
  for (const a of params.agent ?? []) usp.append("agent", a);
  if (params.limit) usp.set("limit", String(params.limit));
  if (params.cursor) usp.set("cursor", params.cursor);
  if (params.allUsers) usp.set("allUsers", "1");
  const qs = usp.toString();
  return request<ListConversationsResp>(`/conversations${qs ? `?${qs}` : ""}`);
}

export function createConversation(
  body: CreateConversationBody = {},
): Promise<CreateConversationResp> {
  return request<CreateConversationResp>("/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getConversation(id: string): Promise<ConversationDetailResp> {
  return request<ConversationDetailResp>(`/conversations/${encodeURIComponent(id)}`);
}

export function sendConversationMessage(
  id: string,
  body: SendConversationMessageBody,
): Promise<SendConversationMessageResp> {
  return request<SendConversationMessageResp>(`/conversations/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getToolCalls(id: string): Promise<{ toolCalls: ToolCallRecord[] }> {
  return request<{ toolCalls: ToolCallRecord[] }>(`/runs/${encodeURIComponent(id)}/tool-calls`);
}

export function cancelRun(id: string): Promise<CancelRunResp> {
  return request(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function sendInput(id: string, input: string): Promise<SendInputResp> {
  return request(`/runs/${encodeURIComponent(id)}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
}

export function getDiagnostics(): Promise<{ checks: DiagnosticCheck[] }> {
  return request<{ checks: DiagnosticCheck[] }>("/diagnostics");
}

export function getHealth(): Promise<HealthInfo> {
  return request<HealthInfo>("/healthz");
}

export function listSchedules(): Promise<ListSchedulesResp> {
  return request<ListSchedulesResp>("/schedules");
}

export function listScheduleRuns(id: string): Promise<ScheduleRunsResp> {
  return request<ScheduleRunsResp>(`/schedules/${encodeURIComponent(id)}/runs`);
}

export function listInbox(): Promise<InboxResp> {
  return request<InboxResp>("/inbox");
}

/**
 * Fetch a starter render.yaml Blueprint that matches this deployment.
 * Returns the raw yaml as a string so the Guide tab can show it inline
 * and offer "copy to clipboard".
 */
export async function getBlueprint(): Promise<string> {
  const res = await fetch("/blueprint", {
    credentials: "include",
    headers: { accept: "text/yaml" },
  });
  if (!res.ok) {
    throw new ApiError(`request failed (${res.status})`, res.status, null);
  }
  return res.text();
}

export function listAgents(): Promise<{ agents: AgentSummary[] }> {
  return request<{ agents: AgentSummary[] }>("/agents");
}

export function listCapabilities(): Promise<CapabilitiesResp> {
  return request<CapabilitiesResp>("/capabilities");
}

export function listConnectors(): Promise<ConnectorsResp> {
  return request<ConnectorsResp>("/connectors");
}

export interface InstallCapabilityBody {
  agentId: string;
  pack: string;
  accessMode: "read" | "read_write";
  config?: Record<string, unknown>;
  requireApproval?: boolean;
}

export interface InstallCapabilityResp {
  ok?: boolean;
  unchanged?: boolean;
  commitSha?: string | null;
  changedFiles?: string[];
  warnings?: string[];
  error?: string;
  details?: string;
  installUrl?: string;
}

export function installCapability(body: InstallCapabilityBody): Promise<InstallCapabilityResp> {
  return request<InstallCapabilityResp>("/capabilities/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface AddableAgent {
  bundleSlug: string;
  bundleName: string;
  agentId: string;
  description: string;
  runtimeKinds: string[];
  capabilities: string[];
  envVars: string[];
  workflowTask: boolean;
}

export interface AgentCatalogResp {
  agents: AddableAgent[];
}

export interface AddAgentBody {
  bundleSlug: string;
  agentId: string;
}

export interface AddAgentResp {
  ok?: boolean;
  unchanged?: boolean;
  commitSha?: string | null;
  changedFiles?: string[];
  warnings?: string[];
  error?: string;
  details?: string;
  installUrl?: string;
}

export function fetchAgentCatalog(wizardUrl: string): Promise<AgentCatalogResp> {
  // The catalog lives on the wizard, not the deployed harness. Browser
  // calls it directly via the operator UI's "wizard URL" hint.
  return fetch(`${wizardUrl.replace(/\/+$/, "")}/api/agents/catalog`).then(async (res) => {
    if (!res.ok) throw new ApiError(`catalog fetch failed: ${res.status}`, res.status, null);
    return (await res.json()) as AgentCatalogResp;
  });
}

export function addAgent(body: AddAgentBody): Promise<AddAgentResp> {
  return request<AddAgentResp>("/agents/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getDeployment(): Promise<DeploymentInfo> {
  return request<DeploymentInfo>("/deployment");
}

export function listEnvVars(): Promise<{ envVars: DeploymentEnvVar[] }> {
  return request<{ envVars: DeploymentEnvVar[] }>("/config/env-vars");
}

export interface SetEnvVarResp {
  ok?: boolean;
  name?: string;
  /**
   * `"queued"` — Render accepted both the env-var write and the
   * follow-up `deploy_only` deploy. The service will restart.
   * `"save_only"` — the value was saved but the deploy trigger
   * failed (see {@link deployError}). The new value won't take
   * effect until the next deploy fires for some other reason.
   */
  restart?: "queued" | "save_only";
  /**
   * Set when `restart === "save_only"`. The Render API's response on
   * the deploy-trigger call, for operator diagnosis.
   */
  deployError?: {
    status: number | null;
    details: string | null;
  };
  error?: string;
  details?: string;
  status?: number;
}

/**
 * Set an env var on this Render service. The harness writes the value
 * via Render's API and then explicitly POSTs to
 * `/v1/services/:id/deploys` with `deployMode: "deploy_only"` so the
 * running process gets recycled with the new value in `process.env`.
 * (The env-var endpoint by itself only saves — it does NOT roll the
 * service. The dashboard's "save and deploy" is a UI convenience the
 * API has no flag for.)
 *
 * Render may kill the current process before the response lands. The
 * UI treats a clean 202 as "saved, restart in flight" and a
 * disconnect after submit as "probably saved, re-poll".
 */
export function setEnvVar(name: string, value: string): Promise<SetEnvVarResp> {
  return request<SetEnvVarResp>(`/config/env-vars/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export interface UpdateAgentModelResp {
  ok?: boolean;
  unchanged?: boolean;
  commitSha?: string | null;
  error?: string;
  details?: string;
  /** Set on 409 needs_install responses. */
  installUrl?: string;
}

/**
 * Edit an agent's model spec. The deployed worker proxies the request
 * to the wizard service, which commits a `render-harness.yaml` change
 * to the scaffolded repo and lets Render auto-deploy redeploy with
 * the new model.
 */
export function updateAgentModel(
  slug: string,
  spec: AgentModelSummary,
): Promise<UpdateAgentModelResp> {
  return request<UpdateAgentModelResp>(`/agents/${encodeURIComponent(slug)}/model`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec }),
  });
}

export function getUsage(opts?: {
  from?: string;
  to?: string;
  allUsers?: boolean;
}): Promise<{ rollups: UsageRow[] }> {
  const usp = new URLSearchParams();
  if (opts?.from) usp.set("from", opts.from);
  if (opts?.to) usp.set("to", opts.to);
  if (opts?.allUsers) usp.set("allUsers", "1");
  const qs = usp.toString();
  return request<{ rollups: UsageRow[] }>(`/usage${qs ? `?${qs}` : ""}`);
}

export function getVitals(opts?: {
  rangeMinutes?: number;
  resolutionSeconds?: number;
}): Promise<VitalsResp> {
  const usp = new URLSearchParams();
  if (opts?.rangeMinutes) usp.set("rangeMinutes", String(opts.rangeMinutes));
  if (opts?.resolutionSeconds) usp.set("resolutionSeconds", String(opts.resolutionSeconds));
  const qs = usp.toString();
  return request<VitalsResp>(`/vitals${qs ? `?${qs}` : ""}`);
}

export function listVitalsLogs(opts?: {
  limit?: number;
  level?: string[];
  type?: string[];
  text?: string;
}): Promise<VitalsLogsResp> {
  const usp = new URLSearchParams();
  if (opts?.limit) usp.set("limit", String(opts.limit));
  for (const level of opts?.level ?? []) usp.append("level", level);
  for (const type of opts?.type ?? []) usp.append("type", type);
  if (opts?.text) usp.append("text", opts.text);
  const qs = usp.toString();
  return request<VitalsLogsResp>(`/vitals/logs${qs ? `?${qs}` : ""}`);
}

// --------------------------------------------------------------------
// SSE streaming
// --------------------------------------------------------------------

export interface StreamHandlers {
  onMessage?: (msg: MessageRecord) => void;
  onStatus?: (status: RunStatus) => void;
  onDone?: () => void;
  onError?: (err: Event) => void;
}

export function streamRun(id: string, handlers: StreamHandlers): () => void {
  const url = `/runs/${encodeURIComponent(id)}/stream`;
  const es = new EventSource(url, { withCredentials: true });
  es.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data) as MessageRecord;
      handlers.onMessage?.(data);
    } catch {
      // ignore malformed payloads
    }
  });
  es.addEventListener("status", (event) => {
    try {
      const data = JSON.parse(event.data) as { status: RunStatus };
      handlers.onStatus?.(data.status);
    } catch {
      // ignore
    }
  });
  es.addEventListener("done", () => {
    handlers.onDone?.();
    es.close();
  });
  es.addEventListener("error", (event) => {
    handlers.onError?.(event);
  });
  return () => es.close();
}

export interface ConversationStreamHandlers {
  onMessage?: (msg: MessageRecord) => void;
  /** Per-run status flips inside the conversation. `runId` identifies which run. */
  onStatus?: (runId: string, status: RunStatus) => void;
  /** A new run was created on the conversation. Use to track the active runId. */
  onRunCreated?: (runId: string) => void;
  onError?: (err: Event) => void;
}

/**
 * Subscribe to a conversation's SSE stream. The stream stays open across
 * run boundaries — terminal status on one run does NOT close it, because
 * the next user message enqueues a fresh run that pushes more events
 * down the same channel. Caller closes by invoking the returned dispose.
 */
export function streamConversation(id: string, handlers: ConversationStreamHandlers): () => void {
  const url = `/conversations/${encodeURIComponent(id)}/stream`;
  const es = new EventSource(url, { withCredentials: true });
  es.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data) as MessageRecord;
      handlers.onMessage?.(data);
    } catch {
      // ignore malformed payloads
    }
  });
  es.addEventListener("status", (event) => {
    try {
      const data = JSON.parse(event.data) as { runId: string; status: RunStatus };
      handlers.onStatus?.(data.runId, data.status);
    } catch {
      // ignore
    }
  });
  es.addEventListener("run_created", (event) => {
    try {
      const data = JSON.parse(event.data) as { runId: string };
      handlers.onRunCreated?.(data.runId);
    } catch {
      // ignore
    }
  });
  es.addEventListener("error", (event) => {
    handlers.onError?.(event);
  });
  return () => es.close();
}
