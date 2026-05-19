/**
 * GitHub-App user-OAuth flow + session API.
 *
 *  - GET /api/auth/login — redirect to GitHub's OAuth authorize page
 *    with a signed state token carrying `next`.
 *  - GET /api/auth/callback — verify state, exchange code for a user
 *    access token, fetch `(id, login, name, avatar_url)`, upsert into
 *    `wizard_users`, set the session cookie, redirect to `next`.
 *  - GET /api/auth/me — return the current session's user record.
 *  - POST /api/auth/logout — clear the cookie.
 *
 * `clientSecret` is the GitHub App's "client secret" (distinct from
 * the App's PEM private key); both come from the same app settings
 * page. The redirect URI passed to GitHub is `${publicUrl}/api/auth/callback`.
 */

import type { Hono } from "hono";
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
  signOAuthState,
  verifyOAuthState,
} from "../auth.js";
import type { WizardStore } from "../store.js";
import type { ErrorResponse } from "../types.js";

export interface RegisterAuthRouteOpts {
  store: WizardStore;
  sessionSecret: string | null;
  /**
   * GitHub App's OAuth client id (= the App's `client_id` from its
   * settings page — same value used in install URLs).
   */
  clientId: string | null;
  /** GitHub App's OAuth client secret (NOT the PEM private key). */
  clientSecret: string | null;
  /** Public origin of the wizard, used to build the redirect URI. */
  publicUrl: string;
  fetchImpl?: typeof fetch;
}

export function registerAuthRoutes(app: Hono, opts: RegisterAuthRouteOpts): void {
  const fetchImpl = opts.fetchImpl ?? fetch;

  app.get("/api/auth/login", (c) => {
    if (!opts.sessionSecret) {
      return c.json<ErrorResponse>({ error: "session_secret_not_configured" }, 503);
    }
    if (!opts.clientId) {
      return c.json<ErrorResponse>({ error: "oauth_not_configured" }, 503);
    }
    const next = sanitizeNext(c.req.query("next"));
    const state = signOAuthState(opts.sessionSecret, next);
    const redirectUri = `${trimSlash(opts.publicUrl)}/api/auth/callback`;
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", opts.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.get("/api/auth/callback", async (c) => {
    if (!opts.sessionSecret) {
      return c.json<ErrorResponse>({ error: "session_secret_not_configured" }, 503);
    }
    if (!opts.clientId || !opts.clientSecret) {
      return c.json<ErrorResponse>({ error: "oauth_not_configured" }, 503);
    }
    const code = c.req.query("code");
    const rawState = c.req.query("state");
    if (!code || !rawState) {
      return c.json<ErrorResponse>({ error: "missing_code_or_state" }, 400);
    }
    let next: string;
    try {
      next = verifyOAuthState(opts.sessionSecret, rawState).next;
    } catch (err) {
      return c.json<ErrorResponse>(
        { error: "invalid_state", details: err instanceof Error ? err.message : String(err) },
        400,
      );
    }

    let tokenJson: { access_token?: string; error?: string; error_description?: string };
    try {
      const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          code,
        }),
      });
      tokenJson = (await tokenRes.json()) as typeof tokenJson;
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "token_exchange_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
    if (!tokenJson.access_token) {
      return c.json<ErrorResponse>(
        {
          error: "token_exchange_rejected",
          details: tokenJson.error_description ?? tokenJson.error ?? "no access_token",
        },
        400,
      );
    }

    let user: { id: number; login: string; name: string | null; avatar_url: string | null };
    try {
      const userRes = await fetchImpl("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${tokenJson.access_token}`,
          accept: "application/vnd.github+json",
          "user-agent": "render-harness-wizard",
        },
      });
      if (!userRes.ok) {
        const body = await userRes.text();
        return c.json<ErrorResponse>(
          { error: "github_user_fetch_failed", details: `${userRes.status}: ${body}` },
          502,
        );
      }
      user = (await userRes.json()) as typeof user;
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "github_user_fetch_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    await opts.store.upsertUser({
      githubUserId: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
    });
    setSessionCookie(c, opts.sessionSecret, user.id);
    return c.redirect(next, 302);
  });

  app.get("/api/auth/me", async (c) => {
    if (!opts.sessionSecret) {
      return c.json<ErrorResponse>({ error: "session_secret_not_configured" }, 503);
    }
    const claims = readSessionCookie(c, opts.sessionSecret);
    if (!claims) return c.json<ErrorResponse>({ error: "unauthenticated" }, 401);
    const user = await opts.store.getUser(claims.githubUserId);
    if (!user) return c.json<ErrorResponse>({ error: "unauthenticated" }, 401);
    return c.json(user);
  });

  app.post("/api/auth/logout", (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function sanitizeNext(raw: string | undefined): string {
  // Only allow same-origin paths starting with `/` to avoid open
  // redirect. Absolute URLs are rejected.
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  return raw;
}
