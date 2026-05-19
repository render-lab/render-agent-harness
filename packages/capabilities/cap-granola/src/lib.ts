/**
 * Shared HTTP client for the Granola.ai public API.
 *
 * Endpoint: https://public-api.granola.ai/v1. Bearer-token auth using
 * the Personal API key from Granola's settings (Beta) or an Enterprise
 * API key for workspace admins.
 *
 * Rate limits per Granola docs (Personal keys): 25 burst capacity,
 * sustained 5 req/sec. We respect Retry-After on 429 with a single
 * backoff retry; sustained throttling propagates to the caller.
 *
 * Webhooks: not yet available. cap-granola uses polling for inbound
 * detection of new notes (`granola.poll_recent`).
 */

export const GRANOLA_API_BASE = "https://public-api.granola.ai/v1";

export interface GranolaFetchArgs {
  apiKey: string;
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface GranolaApiError extends Error {
  status: number;
  retryAfterSeconds?: number;
  granolaMessage?: string;
}

export async function granolaFetch<T>(args: GranolaFetchArgs): Promise<T> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const u = new URL(`${GRANOLA_API_BASE}${args.path}`);
  for (const [k, v] of Object.entries(args.query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  const init: RequestInit = {
    method: args.method ?? "GET",
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      accept: "application/json",
      ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  };

  let res = await fetchImpl(u.toString(), init);
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    if (retryAfter !== null && retryAfter <= 30) {
      await sleep(retryAfter * 1000);
      res = await fetchImpl(u.toString(), init);
    }
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const errMsg =
      (parsed as { error?: string; message?: string }).message ??
      (parsed as { error?: string }).error ??
      text.slice(0, 200);
    const err = new Error(
      `Granola API ${res.status} ${args.method ?? "GET"} ${args.path}: ${errMsg}`,
    ) as GranolaApiError;
    err.status = res.status;
    if (typeof errMsg === "string") err.granolaMessage = errMsg;
    if (res.status === 429) {
      const ra = parseRetryAfter(res.headers.get("retry-after"));
      if (ra !== null) err.retryAfterSeconds = ra;
    }
    throw err;
  }
  return parsed as T;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return n;
  // HTTP-date form — not common from Granola; skip the parse cost.
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function formatGranolaError(tool: string, err: unknown): { content: string; isError: true } {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as GranolaApiError;
    if (e.status === 401 || e.status === 403) {
      return {
        content: `${tool}: Granola API key rejected (${e.status}). Generate a new key at https://app.granola.ai/settings/api-keys and update GRANOLA_API_KEY on the harness service.`,
        isError: true,
      };
    }
    if (e.status === 429) {
      const ra = e.retryAfterSeconds;
      return {
        content: `${tool}: Granola rate limit exceeded (Personal API keys are capped at 25 burst / 5 req/sec). Retry${ra ? ` after ${ra}s` : ""}.`,
        isError: true,
      };
    }
    return {
      content: `${tool}: Granola API ${e.status}: ${e.granolaMessage ?? "unknown"}`,
      isError: true,
    };
  }
  return {
    content: `${tool}: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
  };
}
