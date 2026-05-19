/**
 * Shared HTTP client for the Intercom REST API.
 *
 * Endpoint: https://api.intercom.io  (versionless paths; the API
 * version is negotiated via the Intercom-Version header; we pin
 * "2.10" which has been stable since 2023). Auth is a Bearer token
 * from the per-end-user OAuth flow (the harness's connections API).
 */

export const INTERCOM_API_BASE = "https://api.intercom.io";
export const INTERCOM_API_VERSION = "2.10";

export interface IntercomFetchArgs {
  accessToken: string;
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  fetchImpl?: typeof fetch;
}

export interface IntercomApiError extends Error {
  status: number;
  code?: string;
  intercomMessage?: string;
}

/**
 * Make an authenticated Intercom REST call. On non-2xx, throws an
 * `IntercomApiError` with the parsed error body when available.
 *
 * Intercom error responses look like:
 *   { type: "error.list", errors: [{ code, message }] }
 *
 * We surface the first error's code + message so tool handlers can
 * branch on common cases (`token_revoked`, `not_found`, etc.) without
 * parsing strings.
 */
export async function intercomFetch<T>(args: IntercomFetchArgs): Promise<T> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const u = new URL(`${INTERCOM_API_BASE}${args.path}`);
  for (const [k, v] of Object.entries(args.query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  const res = await fetchImpl(u.toString(), {
    method: args.method ?? "GET",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      accept: "application/json",
      "intercom-version": INTERCOM_API_VERSION,
      ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const errors = (parsed as { errors?: Array<{ code?: string; message?: string }> }).errors;
    const first = errors?.[0];
    const err = new Error(
      `Intercom API ${res.status} ${args.method ?? "GET"} ${args.path}: ${
        first?.message ?? text.slice(0, 200)
      }`,
    ) as IntercomApiError;
    err.status = res.status;
    if (first?.code) err.code = first.code;
    if (first?.message) err.intercomMessage = first.message;
    throw err;
  }
  return parsed as T;
}

/**
 * Translate Intercom errors into actionable tool-result messages.
 * `token_revoked` / 401 → "ask user to reconnect". `not_found` →
 * "Intercom conversation/admin/tag id is wrong". Other codes pass
 * through with the original message.
 */
export function formatIntercomError(
  tool: string,
  err: unknown,
): { content: string; isError: true } {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as IntercomApiError;
    if (e.status === 401 || e.code === "token_revoked" || e.code === "unauthorized") {
      return {
        content: `${tool}: Intercom access token was rejected (${e.code ?? "unauthorized"}). Ask the user to reconnect Intercom at /ui/connections.`,
        isError: true,
      };
    }
    if (e.status === 404 || e.code === "not_found") {
      return {
        content:
          `${tool}: Intercom returned not_found — the conversation_id / admin_id / tag_id may be wrong, or the OAuth scope doesn't cover it. ${e.intercomMessage ?? ""}`.trim(),
        isError: true,
      };
    }
    if (e.code === "rate_limit_exceeded" || e.status === 429) {
      return {
        content:
          `${tool}: Intercom rate-limit exceeded. Back off and retry. ${e.intercomMessage ?? ""}`.trim(),
        isError: true,
      };
    }
    return {
      content: `${tool}: Intercom API ${e.status} ${e.code ?? ""}: ${e.intercomMessage ?? "unknown"}`,
      isError: true,
    };
  }
  return {
    content: `${tool}: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
  };
}

/**
 * Best-effort flatten of an Intercom conversation `parts` (each one
 * is a message, note, assignment, tag, close, or snooze action) into
 * plain text so the model can summarize.
 */
export interface ConversationPart {
  type?: string;
  part_type?: string;
  body?: string | null;
  created_at?: number;
  author?: { type?: string; name?: string; email?: string };
  assigned_to?: { type?: string; id?: string };
}

export function flattenConversationParts(parts: ConversationPart[]): string {
  const lines: string[] = [];
  for (const p of parts) {
    const ts = p.created_at ? new Date(p.created_at * 1000).toISOString() : "?";
    const who = p.author?.name ?? p.author?.email ?? p.author?.type ?? "?";
    const kind = p.part_type ?? p.type ?? "message";
    if (kind === "comment" && p.body) {
      lines.push(`[${ts}] ${who}: ${stripHtml(p.body)}`);
    } else if (kind === "note_and_reopen" || kind === "note") {
      lines.push(`[${ts}] (admin note from ${who}) ${stripHtml(p.body ?? "")}`);
    } else if (kind === "assignment") {
      lines.push(`[${ts}] (assigned to ${p.assigned_to?.id ?? "?"})`);
    } else if (kind === "close") {
      lines.push(`[${ts}] (closed by ${who})`);
    } else if (kind === "snoozed") {
      lines.push(`[${ts}] (snoozed by ${who})`);
    } else if (p.body) {
      lines.push(`[${ts}] (${kind}) ${stripHtml(p.body)}`);
    }
  }
  return lines.join("\n");
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
