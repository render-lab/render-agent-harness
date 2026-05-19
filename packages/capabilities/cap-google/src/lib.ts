/**
 * Shared low-level helpers for the Gmail and Calendar tool sets.
 *
 * Each tool follows the same shape:
 *
 *   1. Pull the per-end-user access token out of `secrets.requireConnection("google")`.
 *      The platform refreshes on use, so the token is guaranteed fresh.
 *   2. Call the Google REST API directly (no SDK — the surface this pack
 *      uses is small enough that the extra dependency isn't worth it).
 *   3. Return JSON.
 *
 * Errors:
 *   - `NeedsConnectionError` from `requireConnection` bubbles up and
 *     `executeToolCall` in core turns it into a `tool_result` with
 *     `is_error: true`, message tells the model to ask the user to
 *     connect.
 *   - Google API errors get re-thrown as plain Error with the response
 *     body included — also surfaces as `is_error: true` to the model.
 */

import type { LocalToolHandler, SecretsContext } from "@render-harness/core";

export const GOOGLE_PROVIDER_ID = "google";

export const PACK_SOURCE = "pack:cap-google";

export interface GoogleFetchArgs {
  accessToken: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Query string parameters. Empty/undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

/**
 * Tight wrapper around `fetch` for Google REST APIs. Surfaces Google's
 * `{ error: { code, message, status } }` envelope as a readable Error
 * message so the model gets actionable feedback instead of a 4xx code.
 */
export async function googleFetch(url: string, args: GoogleFetchArgs): Promise<unknown> {
  const u = new URL(url);
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
      ...(args.headers ?? {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  };
  const res = await fetch(u.toString(), init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const message = extractGoogleErrorMessage(parsed, res.status);
    throw new Error(`Google API ${res.status}: ${message}`);
  }
  return parsed;
}

function extractGoogleErrorMessage(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const err = (parsed as { error: unknown }).error;
    if (err && typeof err === "object") {
      const e = err as { message?: unknown; status?: unknown };
      const msg = typeof e.message === "string" ? e.message : null;
      const sts = typeof e.status === "string" ? e.status : null;
      if (msg && sts) return `${sts}: ${msg}`;
      if (msg) return msg;
    }
    if (typeof err === "string") return err;
  }
  if (typeof parsed === "string") return parsed.slice(0, 500);
  return `HTTP ${status}`;
}

/**
 * Wrap a Google API call so that an "insufficient authentication
 * scopes" 403 gets rewritten into an operator-actionable error
 * naming the surface the agent was trying to use. Without this,
 * the model sees a raw "Request had insufficient authentication
 * scopes" and has to guess what to tell the user.
 *
 * Catches errors thrown by `googleFetch`, inspects the message for
 * the known Google scope-drift signals, and re-throws an Error
 * pointing at the operator UI's Connections tab with concrete
 * remediation. Other errors pass through unchanged.
 */
export async function withScopeHint<T>(
  surface: "drive" | "docs" | "sheets" | "gmail" | "calendar",
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /insufficient authentication scopes/i.test(msg) ||
      /Request had insufficient authentication scopes/i.test(msg) ||
      /PERMISSION_DENIED/i.test(msg)
    ) {
      throw new Error(
        `Your Google connection doesn't include ${surface} access — open the Connections tab in the operator UI, disconnect Google, and reconnect after adding "${surface}" to the pack's \`surfaces:\` config in render-harness.yaml. (Underlying Google error: ${msg.slice(0, 240)})`,
      );
    }
    throw err;
  }
}

// --------------------------------------------------------------------
// Tool wrapper that handles SecretsContext, errors, and JSON
// serialization uniformly.
// --------------------------------------------------------------------

export interface GoogleToolImpl<TInput> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Implementation: receives the validated input and a fresh access
   * token. Throwing is fine — `executeToolCall` turns errors into
   * `is_error: true` tool results.
   */
  call: (args: { input: TInput; accessToken: string; signal: AbortSignal }) => Promise<unknown>;
  /** Optional input validator. Defaults to identity. */
  parseInput?: (raw: unknown) => TInput;
}

export function defineGoogleTool<TInput = unknown>(impl: GoogleToolImpl<TInput>): LocalToolHandler {
  return {
    definition: {
      name: impl.name,
      description: impl.description,
      inputSchema: impl.inputSchema,
      source: PACK_SOURCE,
    },
    handler: async ({ input, secrets, signal }) => {
      if (!secrets) {
        return {
          content:
            "cap-google requires the harness connection API. Upgrade @render-harness/web to 0.5+ and set CONNECTIONS_ENCRYPTION_KEY.",
          isError: true,
        };
      }
      try {
        const conn = await secrets.requireConnection(GOOGLE_PROVIDER_ID);
        const parsedInput = impl.parseInput ? impl.parseInput(input) : (input as TInput);
        const result = await impl.call({
          input: parsedInput,
          accessToken: conn.accessToken,
          signal,
        });
        return { content: JSON.stringify(result, null, 2) };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}

// --------------------------------------------------------------------
// JSON schema helpers (mirrors cap-slack's pattern).
// --------------------------------------------------------------------

export function objectSchema(
  properties: Record<string, { type: string; description?: string; optional?: boolean }>,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(properties).map(([k, v]) => {
        const out: Record<string, unknown> = { type: v.type };
        if (v.description) out.description = v.description;
        return [k, out];
      }),
    ),
    required: Object.entries(properties)
      .filter(([, v]) => !v.optional)
      .map(([k]) => k),
  };
}

// --------------------------------------------------------------------
// SecretsContext shape for tests (so we don't have to import the full
// @render-harness/core surface in test files).
// --------------------------------------------------------------------

export type { SecretsContext };
