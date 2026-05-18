/**
 * Per-end-user OAuth "connection API" routes.
 *
 *   POST   /connections/:provider/start    → returns { authorizeUrl } (auth)
 *   GET    /connections/:provider/callback → OAuth code exchange + upsert (NO bearer auth)
 *   GET    /connections                    → list user's connections + provider catalog (auth)
 *   DELETE /connections/:provider          → revoke + delete (auth)
 *
 * The callback route deliberately doesn't run the harness's bearer
 * `auth` — Google/Microsoft/etc. arrive as anonymous redirects. We
 * authenticate the user by validating the signed `state` token (HMAC,
 * 10-minute TTL, carries the userId) instead.
 *
 * The encryption key + per-provider client id/secret env vars are
 * verified at mount time; if anything is missing we still mount the
 * routes (so the operator UI can render the Connections tab with a
 * "Set CONNECTIONS_ENCRYPTION_KEY to enable" hint) but the start /
 * callback paths return 503 with an actionable error.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ConnectionProviderSummary,
  ConnectionsResp,
  DeleteConnectionResp,
  StartConnectionResp,
  UserConnectionSummary,
} from "@render-harness/contracts";
import {
  buildAuthorizeUrl,
  deleteConnection as deleteConnectionRow,
  exchangeAuthorizationCode,
  getConnectionsEncryptionKey,
  type Logger,
  listConnectionsForUser,
  listRegisteredOAuthProviders,
  loadDecryptedConnection,
  type OAuthProviderConfig,
  type Pool,
  type UserId,
  upsertConnection,
} from "@render-harness/core";
import type { Hono } from "hono";

const STATE_LIFETIME_SECONDS = 10 * 60;

export interface ConnectionsRouteContext {
  pool: Pool;
  auth: (req: Request) => Promise<UserId | null>;
  logger: Logger;
  pathPrefix: string;
  /**
   * Static list of providers (typically from `defineFromConfig`'s
   * `oauthProviders` field). The route handler still queries the
   * registry at request time so providers added between deploys are
   * picked up without restarting the request handler, but this list
   * drives the "requiredBy" annotation on the listing.
   */
  providers?: OAuthProviderConfig[];
  /**
   * Mapping from provider id → capability pack names that depend on
   * it (for the `requiredBy` field on the connections summary). The
   * UI uses this to label "Connect Google — required by cap-google".
   */
  providerRequiredBy?: Map<string, string[]>;
  /**
   * Public origin of the deployed service. Used to build the redirect
   * URI sent to providers. Defaults at request time to
   * `RENDER_EXTERNAL_URL` env, falling back to the request's Host
   * header. Both Google and Microsoft refuse redirects whose host
   * doesn't match the registered URI exactly, so this needs to be
   * stable in production.
   */
  publicUrl?: string;
  /**
   * Cookie / state HMAC secret. Defaults to `UI_COOKIE_SECRET` env.
   * Independent from any session cookie — this only signs the OAuth
   * `state` token.
   */
  stateSecret?: string;
  /** Test injection point. */
  fetchImpl?: typeof fetch;
}

export function registerConnectionsRoutes(app: Hono, ctx: ConnectionsRouteContext): void {
  const r = (path: string) => `${ctx.pathPrefix}${path}`;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const requiredBy = ctx.providerRequiredBy ?? new Map<string, string[]>();

  // ----------------------------------------------------------------
  // GET /connections — list user's connections + provider catalog
  // ----------------------------------------------------------------
  app.get(r("/connections"), async (c) => {
    const userId = await ctx.auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const providers = listRegisteredOAuthProviders();
    const providerSummaries: ConnectionProviderSummary[] = providers.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      defaultScopes: p.defaultScopes,
      clientCredentialsConfigured: Boolean(
        process.env[p.clientIdEnv] && process.env[p.clientSecretEnv],
      ),
      requiredBy: requiredBy.get(p.id) ?? [],
    }));
    const records = await listConnectionsForUser(ctx.pool, userId);
    const providerDisplay = new Map(providers.map((p) => [p.id, p.displayName]));
    const connections: UserConnectionSummary[] = records.map((r) => ({
      provider: r.provider,
      displayName: providerDisplay.get(r.provider) ?? r.provider,
      scopes: r.scopes,
      accountLabel: r.accountLabel,
      connectedAt: r.connectedAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
    return c.json({ providers: providerSummaries, connections } satisfies ConnectionsResp);
  });

  // ----------------------------------------------------------------
  // POST /connections/:provider/start — kick off OAuth flow
  // ----------------------------------------------------------------
  app.post(r("/connections/:provider/start"), async (c) => {
    const userId = await ctx.auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const providerId = c.req.param("provider");
    const provider = listRegisteredOAuthProviders().find((p) => p.id === providerId);
    if (!provider) return c.json({ error: "unknown_provider", provider: providerId }, 404);

    const clientId = process.env[provider.clientIdEnv];
    const clientSecret = process.env[provider.clientSecretEnv];
    if (!clientId || !clientSecret) {
      return c.json(
        {
          error: "oauth_not_configured",
          details: `Provider "${provider.id}" requires ${provider.clientIdEnv} and ${provider.clientSecretEnv}.`,
        },
        503,
      );
    }
    if (!getConnectionsEncryptionKey(process.env)) {
      return c.json(
        {
          error: "connections_key_not_set",
          details:
            "CONNECTIONS_ENCRYPTION_KEY is required to store refresh tokens. Generate with: openssl rand -base64 32",
        },
        503,
      );
    }

    const stateSecret = ctx.stateSecret ?? process.env.UI_COOKIE_SECRET;
    if (!stateSecret) {
      return c.json(
        {
          error: "state_secret_not_set",
          details: "UI_COOKIE_SECRET (or an explicit stateSecret) is required to sign OAuth state.",
        },
        503,
      );
    }

    const publicUrl = resolvePublicUrl(ctx, c.req.raw);
    const redirectUri = `${trimSlash(publicUrl)}${ctx.pathPrefix}/connections/${provider.id}/callback`;
    const state = signOAuthState(stateSecret, {
      userId,
      provider: provider.id,
      nonce: randomBytes(8).toString("hex"),
      exp: Math.floor(Date.now() / 1000) + STATE_LIFETIME_SECONDS,
    });
    const authorizeUrl = buildAuthorizeUrl({
      provider,
      clientId,
      redirectUri,
      state,
    });
    return c.json({ authorizeUrl, provider: provider.id } satisfies StartConnectionResp);
  });

  // ----------------------------------------------------------------
  // GET /connections/:provider/callback — provider redirects here
  //
  // No bearer auth: Google's redirect won't carry one. We recover the
  // userId from the signed `state` token instead.
  // ----------------------------------------------------------------
  app.get(r("/connections/:provider/callback"), async (c) => {
    const providerId = c.req.param("provider");
    const provider = listRegisteredOAuthProviders().find((p) => p.id === providerId);
    if (!provider) return c.json({ error: "unknown_provider", provider: providerId }, 404);

    const code = c.req.query("code");
    const rawState = c.req.query("state");
    const errorParam = c.req.query("error");
    if (errorParam) {
      // Provider-side denial (user clicked Cancel, scope refused, etc.).
      // Don't try to exchange; surface a friendly redirect.
      return c.redirect(
        `${ctx.pathPrefix}/ui#/connections?error=${encodeURIComponent(errorParam)}&provider=${encodeURIComponent(provider.id)}`,
        302,
      );
    }
    if (!code || !rawState) {
      return c.json({ error: "missing_code_or_state" }, 400);
    }

    const stateSecret = ctx.stateSecret ?? process.env.UI_COOKIE_SECRET;
    if (!stateSecret) return c.json({ error: "state_secret_not_set" }, 503);
    const key = getConnectionsEncryptionKey(process.env);
    if (!key) return c.json({ error: "connections_key_not_set" }, 503);

    let claims: OAuthStateClaims;
    try {
      claims = verifyOAuthState(stateSecret, rawState);
    } catch (err) {
      return c.json(
        { error: "invalid_state", details: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
    if (claims.provider !== provider.id) {
      return c.json({ error: "state_provider_mismatch" }, 400);
    }

    const clientId = process.env[provider.clientIdEnv];
    const clientSecret = process.env[provider.clientSecretEnv];
    if (!clientId || !clientSecret) {
      return c.json({ error: "oauth_not_configured" }, 503);
    }

    const publicUrl = resolvePublicUrl(ctx, c.req.raw);
    const redirectUri = `${trimSlash(publicUrl)}${ctx.pathPrefix}/connections/${provider.id}/callback`;

    let parsed: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
    try {
      parsed = await exchangeAuthorizationCode({
        provider,
        clientId,
        clientSecret,
        code,
        redirectUri,
        fetchImpl,
      });
    } catch (err) {
      ctx.logger.error(
        { provider: provider.id, err: err instanceof Error ? err.message : String(err) },
        "connection token exchange failed",
      );
      return c.json(
        {
          error: "token_exchange_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    const expiresAt = new Date(Date.now() + (parsed.expiresIn ?? 3600) * 1000);
    let accountLabel: string | undefined;
    if (provider.fetchAccountLabel) {
      try {
        accountLabel = await provider.fetchAccountLabel(parsed.accessToken);
      } catch (err) {
        ctx.logger.warn(
          { provider: provider.id, err: err instanceof Error ? err.message : String(err) },
          "fetchAccountLabel failed; storing without label",
        );
      }
    }

    await upsertConnection(
      ctx.pool,
      {
        userId: claims.userId,
        provider: provider.id,
        // refreshToken is guaranteed by exchangeAuthorizationCode (it
        // throws if the provider didn't return one).
        refreshToken: parsed.refreshToken as string,
        accessToken: parsed.accessToken,
        expiresAt,
        scopes: parsed.scopes ?? provider.defaultScopes,
        ...(accountLabel ? { accountLabel } : {}),
      },
      key,
    );

    // Redirect to the operator UI's Connections tab on success. The hash
    // (`#/connections`) is the SPA route the ConnectionsTab listens for.
    return c.redirect(
      `${ctx.pathPrefix}/ui#/connections?connected=${encodeURIComponent(provider.id)}`,
      302,
    );
  });

  // ----------------------------------------------------------------
  // DELETE /connections/:provider — best-effort revoke + delete
  // ----------------------------------------------------------------
  app.delete(r("/connections/:provider"), async (c) => {
    const userId = await ctx.auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const providerId = c.req.param("provider");
    const provider = listRegisteredOAuthProviders().find((p) => p.id === providerId);
    if (!provider) return c.json({ error: "unknown_provider", provider: providerId }, 404);

    const key = getConnectionsEncryptionKey(process.env);
    if (key) {
      const clientId = process.env[provider.clientIdEnv];
      const clientSecret = process.env[provider.clientSecretEnv];
      try {
        const existing = await loadDecryptedConnection(
          ctx.pool,
          { userId, provider: provider.id },
          key,
        );
        if (existing && clientId && clientSecret) {
          await revokeAtProvider({
            provider,
            accessToken: existing.accessToken,
            refreshToken: existing.refreshToken,
            clientId,
            clientSecret,
            fetchImpl,
            logger: ctx.logger,
          });
        }
      } catch (err) {
        // Best-effort: log and continue with row delete.
        ctx.logger.warn(
          { provider: provider.id, err: err instanceof Error ? err.message : String(err) },
          "provider-side revoke failed; deleting local row anyway",
        );
      }
    }

    await deleteConnectionRow(ctx.pool, { userId, provider: provider.id });
    return c.json({ ok: true, provider: provider.id } satisfies DeleteConnectionResp);
  });
}

async function revokeAtProvider(args: {
  provider: OAuthProviderConfig;
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: typeof fetch;
  logger: Logger;
}): Promise<void> {
  if (args.provider.revoke) {
    await args.provider.revoke({
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
    });
    return;
  }
  if (!args.provider.revokeUrl) return; // no revocation endpoint declared; skip.
  const body = new URLSearchParams({ token: args.accessToken });
  const res = await args.fetchImpl(args.provider.revokeUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    args.logger.warn(
      { provider: args.provider.id, status: res.status },
      "provider revoke endpoint returned non-2xx; continuing with local delete",
    );
  }
}

function resolvePublicUrl(ctx: ConnectionsRouteContext, req: Request): string {
  if (ctx.publicUrl) return ctx.publicUrl;
  const fromEnv = process.env.CONNECTIONS_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL;
  if (fromEnv) return fromEnv;
  // Last resort: derive from the Host header. Useful in local dev,
  // useless in prod behind any proxy that strips X-Forwarded-Proto.
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// --------------------------------------------------------------------
// OAuth state signing
//
// Standalone HMAC token (not a cookie). Carries `userId` so the callback
// route — which can't run bearer auth on Google's redirect — can still
// associate the OAuth response with the right end user.
// --------------------------------------------------------------------

interface OAuthStateClaims {
  userId: string;
  provider: string;
  nonce: string;
  exp: number;
}

function signOAuthState(secret: string, claims: OAuthStateClaims): string {
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyOAuthState(secret: string, token: string): OAuthStateClaims {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("malformed state");
  const [payload, providedSig] = parts as [string, string];
  const expectedSig = base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
  const aBuf = Buffer.from(providedSig);
  const bBuf = Buffer.from(expectedSig);
  if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) {
    throw new Error("state signature mismatch");
  }
  const claims = JSON.parse(
    Buffer.from(base64UrlDecode(payload)).toString("utf8"),
  ) as OAuthStateClaims;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("state expired");
  }
  if (typeof claims.userId !== "string" || typeof claims.provider !== "string") {
    throw new Error("missing userId or provider claim");
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
