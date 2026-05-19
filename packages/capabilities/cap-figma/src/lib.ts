/**
 * Shared HTTP client for the Figma REST API.
 *
 * Endpoint: https://api.figma.com/v1. Bearer-token auth using a
 * per-end-user access token from the harness's connections API.
 *
 * Figma error shape: { status: number, err: string }. We surface
 * those as `FigmaApiError` so tool handlers can branch on common
 * cases (401 → reconnect, 403 → scope drift, 404 → bad id).
 */

export const FIGMA_API_BASE = "https://api.figma.com/v1";

export interface FigmaFetchArgs {
  accessToken: string;
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface FigmaApiError extends Error {
  status: number;
  figmaMessage?: string;
}

export async function figmaFetch<T>(args: FigmaFetchArgs): Promise<T> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const u = new URL(`${FIGMA_API_BASE}${args.path}`);
  for (const [k, v] of Object.entries(args.query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  const init: RequestInit = {
    method: args.method ?? "GET",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      accept: "application/json",
      ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  };
  const res = await fetchImpl(u.toString(), init);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const errMsg =
      (parsed as { err?: string; message?: string }).err ??
      (parsed as { message?: string }).message ??
      text.slice(0, 200);
    const err = new Error(
      `Figma API ${res.status} ${args.method ?? "GET"} ${args.path}: ${errMsg}`,
    ) as FigmaApiError;
    err.status = res.status;
    if (typeof errMsg === "string") err.figmaMessage = errMsg;
    throw err;
  }
  return parsed as T;
}

/**
 * Translate Figma errors into actionable tool-result messages.
 *
 * 401 → "ask user to reconnect".
 *
 * 403 (Forbidden) is Figma's primary signal for scope drift — the
 * pack opted into `accessMode: "read"` after a user connected with
 * the full bundle, or vice-versa. Surface that as the reusable
 * scope-drift hint pattern (same flavor as cap-google's
 * withScopeHint).
 *
 * 404 → bad id / no permission on the resource.
 *
 * The `expectedAction` argument names what the agent was trying to
 * do ("read file", "post comment") so the operator sees a concrete
 * instruction in the resulting error.
 */
export function formatFigmaError(
  tool: string,
  expectedAction:
    | "read file content"
    | "read file metadata"
    | "read comments"
    | "post comment"
    | "list team projects"
    | "list project files"
    | "read current user",
  err: unknown,
): { content: string; isError: true } {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as FigmaApiError;
    if (e.status === 401) {
      return {
        content: `${tool}: Figma access token was rejected (401). Ask the user to reconnect Figma at /ui/connections.`,
        isError: true,
      };
    }
    if (e.status === 403) {
      return {
        content:
          `${tool}: Figma returned 403 (Forbidden) trying to ${expectedAction}. The connected access token doesn't include the required scope — open the Connections tab in the operator UI, disconnect Figma, update the pack's accessMode (and surfaces if relevant), and reconnect. ${e.figmaMessage ?? ""}`.trim(),
        isError: true,
      };
    }
    if (e.status === 404) {
      return {
        content:
          `${tool}: Figma returned 404 — the id may be wrong, the file/team may be in a different workspace, or the access token's plan tier doesn't include this endpoint. ${e.figmaMessage ?? ""}`.trim(),
        isError: true,
      };
    }
    if (e.status === 429) {
      return {
        content:
          `${tool}: Figma rate limit exceeded. Back off and retry. ${e.figmaMessage ?? ""}`.trim(),
        isError: true,
      };
    }
    return {
      content: `${tool}: Figma API ${e.status}: ${e.figmaMessage ?? "unknown"}`,
      isError: true,
    };
  }
  return {
    content: `${tool}: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
  };
}
