/**
 * Cookie-session helpers for the operator UI.
 *
 * `@render-harness/web` accepts a `Bearer <api-key>` header and resolves
 * it to a `UserId`. A browser UI needs the same identity but without
 * making the user paste the bearer on every request, so we layer a signed
 * cookie on top:
 *
 *   1. Browser visits `<ui>/login`, posts the API key.
 *   2. We call the existing auth resolver with a synthetic
 *      `Authorization: Bearer ...` request to validate the key.
 *   3. On success we set a signed cookie carrying the resolved `userId`.
 *   4. {@link wrapWithSession} is plugged into `serveWeb` so all routes
 *      accept either the cookie OR the original bearer header. curl-based
 *      ops still work; browsers stay logged in.
 *
 * The signing secret comes from `UI_COOKIE_SECRET` (env). If unset we
 * generate a random per-process secret and warn — fine for local dev,
 * means cookies don't survive a restart.
 */

import type { UserId } from "@render-harness/core";
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";

export type AuthResolver = (req: Request) => Promise<UserId | null>;

export interface CookieSessionConfig {
  cookieName: string;
  secret: string;
  /** Lifetime in seconds. Default: 7 days. */
  maxAge: number;
  /** Set Secure flag on the cookie. Default: true outside dev. */
  secure: boolean;
}

const DEFAULT_COOKIE_NAME = "rh_ui_session";
const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function buildCookieConfig(opts: {
  cookieName?: string;
  secret?: string;
  maxAge?: number;
  secure?: boolean;
}): CookieSessionConfig {
  const envSecret = process.env.UI_COOKIE_SECRET;
  const secret = opts.secret ?? envSecret ?? generateEphemeralSecret();
  const isDev = process.env.NODE_ENV !== "production";
  return {
    cookieName: opts.cookieName ?? DEFAULT_COOKIE_NAME,
    secret,
    maxAge: opts.maxAge ?? DEFAULT_MAX_AGE_SECONDS,
    secure: opts.secure ?? !isDev,
  };
}

/**
 * Read the signed session cookie from a `Request`, returning the userId
 * encoded in it or `null` if the cookie is missing/invalid.
 *
 * Hono's cookie helpers want a {@link Context}, but they only ever read
 * `c.req.raw.headers.get("Cookie")` under the hood — so we pass a minimal
 * shim. Keeps verification in Hono's well-tested code without taking on
 * an internal dependency.
 */
export async function readSessionCookie(
  req: Request,
  cfg: CookieSessionConfig,
): Promise<UserId | null> {
  const shim = { req: { raw: req } } as unknown as Context;
  const value = await getSignedCookie(shim, cfg.secret, cfg.cookieName);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve the request to a `UserId`, accepting either the cookie session
 * or a bearer header. Returns `null` if neither validates. Used inside
 * `/ui/*` handlers where we already have the Hono Context.
 */
export async function resolveSession(
  c: Context,
  cfg: CookieSessionConfig,
  upstreamAuth: AuthResolver,
): Promise<UserId | null> {
  const fromCookie = await readSessionCookie(c.req.raw, cfg);
  if (fromCookie) return fromCookie;
  return upstreamAuth(c.req.raw);
}

/**
 * Wrap an existing `(Request) => Promise<UserId | null>` resolver so it
 * also accepts the signed UI session cookie. The web service plugs the
 * wrapped resolver into all of its routes when `serveWeb({ ui: true })`,
 * so JSON+SSE callers can use either bearer or cookie.
 */
export function wrapWithSession(
  upstream: AuthResolver,
  opts: {
    cookieSecret?: string;
    cookieName?: string;
    cookieMaxAge?: number;
    cookieSecure?: boolean;
  } = {},
): AuthResolver {
  const cfg = buildCookieConfig({
    ...(opts.cookieName !== undefined ? { cookieName: opts.cookieName } : {}),
    ...(opts.cookieSecret !== undefined ? { secret: opts.cookieSecret } : {}),
    ...(opts.cookieMaxAge !== undefined ? { maxAge: opts.cookieMaxAge } : {}),
    ...(opts.cookieSecure !== undefined ? { secure: opts.cookieSecure } : {}),
  });
  return async (req: Request) => {
    const fromCookie = await readSessionCookie(req, cfg);
    if (fromCookie) return fromCookie;
    return upstream(req);
  };
}

/**
 * Mint a signed session cookie for the given `userId`. Caller is expected
 * to have already validated the user.
 */
export async function issueSession(
  c: Context,
  cfg: CookieSessionConfig,
  userId: UserId,
): Promise<void> {
  await setSignedCookie(c, cfg.cookieName, userId, cfg.secret, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: cfg.secure,
    maxAge: cfg.maxAge,
  });
}

export function clearSession(c: Context, cfg: CookieSessionConfig): void {
  deleteCookie(c, cfg.cookieName, { path: "/" });
}

/**
 * Forge a `Request` carrying `Authorization: Bearer <apiKey>` so we can
 * reuse the upstream resolver (which only knows how to read headers) for
 * the login form path.
 */
export function authRequestForBearer(apiKey: string): Request {
  return new Request("https://internal.invalid/login", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

function generateEphemeralSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}
