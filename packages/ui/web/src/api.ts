/**
 * Browser-side client for the harness web service.
 *
 * Uses cookies for auth (set by `/ui/login`); no bearer header is needed
 * from the browser. Errors are surfaced as `ApiError` so the UI can show
 * a coherent message.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: unknown,
  ) {
    super(message);
  }
}

export interface RunSummary {
  id: string;
  agentName: string;
  agentVersion: string;
  status: RunStatus;
  userId: string | null;
  totalCostUsd: number;
  cursor: {
    turn: number;
    toolCalls: number;
    wallMs: number;
    usage: { inputTokens: number; outputTokens: number };
  };
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature?: string };

export interface MessageRecord {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  createdAt: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  idempotencyKey: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: {
    content: string;
    truncatedContent: string;
    tokenCount: number;
    isError: boolean;
    durationMs: number;
    createdAt: string;
  } | null;
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
  budget?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
  hasLocalTools: boolean;
  hasSkills: boolean;
  /** Capability pack names declared on the agent. */
  capabilityPacks?: string[];
}

export interface UsageRow {
  day: string;
  agentName: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ListRunsResp {
  runs: RunSummary[];
  nextCursor: string | null;
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
      window.location.href = `/ui/login?next=${encodeURIComponent(window.location.pathname)}`;
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

export interface CreateRunBody {
  input: string;
  agentName?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateRunResp {
  runId: string;
  status: RunStatus;
}

export function createRun(body: CreateRunBody): Promise<CreateRunResp> {
  return request<CreateRunResp>("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Look up the caller's most recent non-terminal run for an agent. The Chat
 * tab uses this to "continue last session" on page load. Returns
 * `{ run: null }` (200) when no active session exists.
 */
export function getActiveRun(agentName?: string): Promise<{ run: RunSummary | null }> {
  const qs = agentName ? `?agent=${encodeURIComponent(agentName)}` : "";
  return request<{ run: RunSummary | null }>(`/runs/active${qs}`);
}

export interface RunDetail {
  run: RunSummary;
  messages: MessageRecord[];
}

export function getRun(id: string): Promise<RunDetail> {
  return request<RunDetail>(`/runs/${encodeURIComponent(id)}`);
}

export function getToolCalls(id: string): Promise<{ toolCalls: ToolCallRecord[] }> {
  return request<{ toolCalls: ToolCallRecord[] }>(`/runs/${encodeURIComponent(id)}/tool-calls`);
}

export function cancelRun(id: string): Promise<{ runId: string; cancelRequested: boolean }> {
  return request(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function sendInput(id: string, input: string): Promise<{ runId: string; status: string }> {
  return request(`/runs/${encodeURIComponent(id)}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
}

export interface DiagnosticCheck {
  id: string;
  level: "ok" | "warn" | "error";
  title: string;
  message: string;
  hint?: string;
}

export function getDiagnostics(): Promise<{ checks: DiagnosticCheck[] }> {
  return request<{ checks: DiagnosticCheck[] }>("/diagnostics");
}

export interface HealthInfo {
  ok: boolean;
  queue: string;
  agents: string[];
  /** ISO timestamp captured when the web service process started. */
  bootedAt: string;
}

export function getHealth(): Promise<HealthInfo> {
  return request<HealthInfo>("/healthz");
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
