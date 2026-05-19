/**
 * Cloudflare Turnstile verification. The SPA mounts the widget on the
 * final review screen and POSTs the resulting token to /api/scaffold;
 * the server verifies it against Turnstile's HTTP API before any
 * GitHub work happens.
 *
 * Returns true if the token is valid OR the verifier is disabled (no
 * secret configured). The latter is intentional for dev — running the
 * wizard locally without a Turnstile site key shouldn't break the flow.
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface VerifyTurnstileOpts {
  /** Server secret from Cloudflare; null means skip verification. */
  secret: string | null;
  /** Token submitted by the client. */
  token: string;
  /** Optional remote IP for Cloudflare's risk scoring. */
  remoteIp?: string;
  /** Override the fetch (tests). */
  fetchFn?: typeof fetch;
}

export interface VerifyTurnstileResult {
  ok: boolean;
  errorCodes?: string[];
}

export async function verifyTurnstile(opts: VerifyTurnstileOpts): Promise<VerifyTurnstileResult> {
  if (!opts.secret) return { ok: true };
  if (!opts.token) return { ok: false, errorCodes: ["missing-token"] };

  const body = new URLSearchParams({
    secret: opts.secret,
    response: opts.token,
    ...(opts.remoteIp ? { remoteip: opts.remoteIp } : {}),
  });

  const f = opts.fetchFn ?? fetch;
  const res = await f(VERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    return { ok: false, errorCodes: [`http-${res.status}`] };
  }
  const data = (await res.json()) as { success: boolean; "error-codes"?: string[] };
  if (data.success) return { ok: true };
  return {
    ok: false,
    ...(data["error-codes"] ? { errorCodes: data["error-codes"] } : {}),
  };
}
