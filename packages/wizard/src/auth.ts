/**
 * Session cookie helpers + GitHub-App user-OAuth flow.
 *
 * The GitHub App used to scaffold managed repos has a separate
 * user-authorization toggle (the "Request user authorization (OAuth)
 * during installation" setting). When enabled, the app exposes an
 * OAuth flow whose `state` and `code` we exchange for a short-lived
 * user access token via `POST /login/oauth/access_token`. From there
 * we call `GET /user` to read `(id, login, name, avatar_url)` and
 * upsert into `wizard_users`.
 *
 * The user token itself is discarded — we never need it again. The
 * row in `wizard_users` is the canonical "is this person logged in"
 * record. A signed cookie carries the user id on subsequent requests.
 *
 * No external session store: the cookie payload IS the session. We
 * HMAC-sign it with `SESSION_SECRET`; clients can't forge it.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const COOKIE_NAME = "rh_wizard_session";
const COOKIE_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days
const STATE_LIFETIME_SECONDS = 10 * 60; // 10 minutes

export interface SessionClaims {
  githubUserId: number;
  exp: number;
}

export interface OAuthStateClaims {
  next: string;
  exp: number;
  nonce: string;
}

export function setSessionCookie(c: Context, secret: string, githubUserId: number): void {
  const claims: SessionClaims = {
    githubUserId,
    exp: Math.floor(Date.now() / 1000) + COOKIE_LIFETIME_SECONDS,
  };
  const value = signToken(secret, claims);
  setCookie(c, COOKIE_NAME, value, {
    httpOnly: true,
    secure: !isLocalhost(c),
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_LIFETIME_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  setCookie(c, COOKIE_NAME, "", {
    httpOnly: true,
    secure: !isLocalhost(c),
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
}

export function readSessionCookie(c: Context, secret: string): SessionClaims | null {
  const raw = getCookie(c, COOKIE_NAME);
  if (!raw) return null;
  try {
    const claims = verifyToken<SessionClaims>(secret, raw);
    if (!claims || typeof claims.githubUserId !== "number") return null;
    return claims;
  } catch {
    return null;
  }
}

export function signOAuthState(secret: string, next: string): string {
  const claims: OAuthStateClaims = {
    next,
    exp: Math.floor(Date.now() / 1000) + STATE_LIFETIME_SECONDS,
    nonce: randomBytes(8).toString("hex"),
  };
  return signToken(secret, claims);
}

export function verifyOAuthState(secret: string, token: string): OAuthStateClaims {
  const claims = verifyToken<OAuthStateClaims>(secret, token);
  if (!claims) throw new Error("invalid state token");
  if (typeof claims.next !== "string") throw new Error("missing next claim");
  return claims;
}

// ---------------------------------------------------------------------
// HMAC token internals
// ---------------------------------------------------------------------

function signToken(secret: string, claims: object): string {
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyToken<T>(secret: string, token: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, providedSig] = parts as [string, string];
  const expectedSig = base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
  const aBuf = Buffer.from(providedSig);
  const bBuf = Buffer.from(expectedSig);
  if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) return null;
  let claims: T & { exp?: number };
  try {
    claims = JSON.parse(Buffer.from(base64UrlDecode(payload)).toString("utf8")) as T & {
      exp?: number;
    };
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return claims;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function isLocalhost(c: Context): boolean {
  const host = c.req.header("host") ?? "";
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(host);
}
