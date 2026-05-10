/**
 * Browser-side client for the harness web service.
 *
 * Uses cookies for auth (set by `/ui/login`); no bearer header is needed
 * from the browser. Errors are surfaced as `ApiError` so the UI can show
 * a coherent message.
 *
 * Wire types are imported from `@render-harness/contracts` so the SPA
 * and server share one source of truth.
 */

import type {
  AgentSummary,
  CancelRunResp,
  ContentBlock,
  CreateRunBody,
  CreateRunResp,
  DiagnosticCheck,
  HealthInfo,
  ListRunsResp,
  MessageRecord,
  RunDetailResp,
  RunStatus,
  RunSummary,
  SendInputResp,
  ToolCallRecord,
  UsageRow,
} from "@render-harness/contracts";

export type {
  AgentSummary,
  ContentBlock,
  DiagnosticCheck,
  HealthInfo,
  MessageRecord,
  RunStatus,
  RunSummary,
  ToolCallRecord,
  UsageRow,
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

export function getRun(id: string): Promise<RunDetailResp> {
  return request<RunDetailResp>(`/runs/${encodeURIComponent(id)}`);
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
