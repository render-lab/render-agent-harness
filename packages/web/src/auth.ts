import type { UserId } from "@render-harness/core";

/**
 * Default bearer-key auth resolver. Reads `Authorization: Bearer <key>`,
 * compares against `WEB_API_KEY` in constant time, and returns the literal
 * userId `"api-key"` on success. Fails closed when `WEB_API_KEY` is unset
 * so a misconfigured deploy never accidentally exposes the API.
 */
export function defaultApiKeyAuth(): (req: Request) => Promise<UserId | null> {
  const expected = process.env.WEB_API_KEY;
  if (!expected) {
    return async () => null;
  }
  return async (req) => {
    const header = req.headers.get("authorization") ?? "";
    if (!header.toLowerCase().startsWith("bearer ")) return null;
    const presented = header.slice("bearer ".length).trim();
    return constantTimeEquals(presented, expected) ? "api-key" : null;
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
