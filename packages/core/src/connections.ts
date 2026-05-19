/**
 * Per-end-user OAuth connections for capability packs.
 *
 * This module is the platform side of the "Connect <provider>" UX:
 *
 *   1. A capability pack declares an {@link OAuthProviderConfig} (URLs,
 *      env var names for client id/secret, default scopes). The pack
 *      registers it via `registerOAuthProvider` at boot — either
 *      directly or implicitly through `defineFromConfig` in
 *      `@render-harness/registry`.
 *
 *   2. The HTTP layer (`@render-harness/web`) reads the registered
 *      providers and mounts `/connections/:provider/start|callback`
 *      routes. The callback exchanges Google/Microsoft/etc.'s
 *      authorization code for tokens via `exchangeAuthorizationCode`
 *      and upserts them via `upsertConnection`.
 *
 *   3. At tool-call time, `runAgent` builds a {@link SecretsContext}
 *      scoped to the run's `userId` and passes it into every local-tool
 *      handler. Pack tools call `secrets.requireConnection("google")`
 *      and receive a guaranteed-fresh access token; the platform
 *      handles refresh-on-use atomically. If the user hasn't connected
 *      yet, the tool gets a {@link NeedsConnectionError} which surfaces
 *      to the model as an actionable tool error ("ask the user to
 *      connect at /ui/connections").
 *
 * Tokens (both access and refresh) are stored in `agent_user_connections`
 * encrypted with AES-256-GCM. The encryption key comes from
 * `CONNECTIONS_ENCRYPTION_KEY` (base64-encoded 32-byte secret). Refresh
 * tokens are NEVER returned through the SecretsContext — only valid
 * access tokens.
 *
 * Multi-tenant safety: every query uses `user_id` from the run; tools
 * cannot construct a SecretsContext for any user other than the run's
 * owner.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "./logger.js";
import type { UserId } from "./types.js";

// --------------------------------------------------------------------
// Provider configuration (declared by capability packs)
// --------------------------------------------------------------------

/**
 * Standard OAuth 2.0 authorization-code-with-refresh-token provider.
 *
 * Most modern SaaS APIs (Google, Microsoft, Slack, Notion, Linear,
 * Atlassian, Dropbox, Stripe Connect, etc.) fit this shape. Providers
 * that don't (OAuth 1.0a, JWT-bearer service accounts) are out of scope
 * for this primitive.
 */
export interface OAuthProviderConfig {
  /** Stable id used in URLs and as the `provider` column. Lowercase, slug-shaped. */
  id: string;
  /** Human-friendly label for the UI ("Google", "Microsoft 365"). */
  displayName: string;
  /** Provider's authorize endpoint (RFC 6749 §3.1). */
  authorizeUrl: string;
  /** Provider's token endpoint (RFC 6749 §3.2). */
  tokenUrl: string;
  /** Optional token revocation endpoint (RFC 7009). */
  revokeUrl?: string;
  /** Env var holding the OAuth client id (app-level, not per-user). */
  clientIdEnv: string;
  /** Env var holding the OAuth client secret. */
  clientSecretEnv: string;
  /** Scopes requested on every connect. */
  defaultScopes: string[];
  /**
   * Extra static params appended to the authorize URL (e.g. Google's
   * `access_type=offline` + `prompt=consent`, Microsoft's `prompt=select_account`).
   */
  extraAuthorizeParams?: Record<string, string>;
  /**
   * Parse a non-standard token endpoint response. Default behaviour is
   * RFC 6749 (`{ access_token, refresh_token, expires_in, scope }`).
   * Override for Slack-style responses where the user token lives under
   * `authed_user.access_token`.
   */
  parseTokenResponse?: (raw: unknown) => ParsedTokenResponse;
  /**
   * Provider-specific revocation. Default: `POST revokeUrl` with form-encoded
   * `token=<accessToken>` per RFC 7009. Override when the provider needs a
   * different shape (e.g. Slack's `auth.revoke`).
   */
  revoke?: (args: {
    accessToken: string;
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }) => Promise<void>;
  /**
   * Optional: fetch a human-readable account label (typically the user's
   * email) to show in the "Connected as foo@example.com" UI. Errors are
   * swallowed; the label just stays null.
   */
  fetchAccountLabel?: (accessToken: string) => Promise<string | undefined>;
  /**
   * Set to `true` for providers that issue long-lived access tokens
   * with no `refresh_token` (Notion's default flow, Stripe Connect's
   * standard-account flow, some legacy SaaS). When unset (default),
   * `exchangeAuthorizationCode` throws if the token endpoint omits a
   * refresh_token — that's the right behaviour for Google / Microsoft /
   * Atlassian / etc. where missing-refresh-token is almost always a
   * misconfigured scope (Google's `access_type=offline + prompt=consent`,
   * Microsoft's `offline_access`).
   *
   * When `true`, refresh-on-use becomes a no-op: the stored access
   * token is returned unchanged from `SecretsContext.requireConnection`
   * until the operator manually re-runs the connect flow. Pack tools
   * should handle the eventual 401 from the provider with a clear
   * "re-connect at /ui/connections" message.
   */
  refreshTokenOptional?: boolean;
}

export interface ParsedTokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until access_token expiry. Defaults to 3600 when omitted. */
  expiresIn?: number;
  /** Space-separated scope string from the provider, parsed to an array. */
  scopes?: string[];
}

// --------------------------------------------------------------------
// Process-level provider registry
//
// Providers are deployment-wide (one Google OAuth app per harness),
// not per-agent. Packs call `registerOAuthProvider` at boot; the
// web/UI routes and the per-run SecretsContext read from the same
// registry. Re-registering the same id replaces the previous config
// (idempotent — packs may be loaded by both the web service and the
// worker independently).
// --------------------------------------------------------------------

const REGISTRY = new Map<string, OAuthProviderConfig>();

export function registerOAuthProvider(cfg: OAuthProviderConfig): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cfg.id)) {
    throw new Error(`registerOAuthProvider: id "${cfg.id}" must match [a-z0-9][a-z0-9-]*`);
  }
  REGISTRY.set(cfg.id, cfg);
}

export function listRegisteredOAuthProviders(): OAuthProviderConfig[] {
  return Array.from(REGISTRY.values());
}

export function getRegisteredOAuthProvider(id: string): OAuthProviderConfig | undefined {
  return REGISTRY.get(id);
}

/** Test helper. Clears the registry. Not exported from the package's main barrel. */
export function _clearOAuthProviderRegistryForTests(): void {
  REGISTRY.clear();
}

// --------------------------------------------------------------------
// Encryption (AES-256-GCM)
// --------------------------------------------------------------------

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const KEY_VERSION = 1;
const REFRESH_LEAD_MS = 60_000; // refresh when <60s of validity remains

export class ConnectionsKeyMissingError extends Error {
  constructor() {
    super(
      "CONNECTIONS_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it on the service.",
    );
    this.name = "ConnectionsKeyMissingError";
  }
}

/**
 * Decode the encryption key from env. Returns `null` when unset so the
 * web layer can mount routes conditionally and the diagnostics route
 * can surface a clear warning instead of crashing on boot.
 */
export function getConnectionsEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.CONNECTIONS_ENCRYPTION_KEY;
  if (!raw) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch (err) {
    throw new Error(
      `CONNECTIONS_ENCRYPTION_KEY is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (buf.length !== 32) {
    throw new Error(
      `CONNECTIONS_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return buf;
}

interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
  scopes: string[];
  accountLabel?: string;
}

interface CipherBlob {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function encryptBundle(bundle: TokenBundle, key: Buffer): CipherBlob {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

function decryptBundle(blob: CipherBlob, key: Buffer): TokenBundle {
  const decipher = createDecipheriv(ALG, key, blob.iv);
  decipher.setAuthTag(blob.authTag);
  const plaintext = Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as TokenBundle;
}

// --------------------------------------------------------------------
// Persistence
// --------------------------------------------------------------------

interface ConnectionRow {
  id: string;
  user_id: string;
  provider: string;
  scopes: string[];
  account_label: string | null;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ConnectionRecord {
  provider: string;
  scopes: string[];
  accountLabel: string | null;
  connectedAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface UpsertConnectionArgs {
  userId: UserId;
  provider: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  accountLabel?: string | null;
}

export async function upsertConnection(
  pool: Pool | PoolClient,
  args: UpsertConnectionArgs,
  key: Buffer,
): Promise<void> {
  const bundle: TokenBundle = {
    accessToken: args.accessToken,
    refreshToken: args.refreshToken,
    expiresAt: args.expiresAt.toISOString(),
    scopes: args.scopes,
    ...(args.accountLabel ? { accountLabel: args.accountLabel } : {}),
  };
  const blob = encryptBundle(bundle, key);
  await pool.query(
    `INSERT INTO agent_user_connections
       (user_id, provider, scopes, account_label, ciphertext, iv, auth_tag, key_version, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       scopes = EXCLUDED.scopes,
       account_label = EXCLUDED.account_label,
       ciphertext = EXCLUDED.ciphertext,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       key_version = EXCLUDED.key_version,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [
      args.userId,
      args.provider,
      args.scopes,
      args.accountLabel ?? null,
      blob.ciphertext,
      blob.iv,
      blob.authTag,
      KEY_VERSION,
      args.expiresAt,
    ],
  );
}

export async function listConnectionsForUser(
  pool: Pool | PoolClient,
  userId: UserId,
): Promise<ConnectionRecord[]> {
  const res = await pool.query<ConnectionRow>(
    `SELECT * FROM agent_user_connections
       WHERE user_id = $1
       ORDER BY provider ASC`,
    [userId],
  );
  return res.rows.map((row) => ({
    provider: row.provider,
    scopes: row.scopes,
    accountLabel: row.account_label,
    connectedAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }));
}

export async function deleteConnection(
  pool: Pool | PoolClient,
  args: { userId: UserId; provider: string },
): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM agent_user_connections WHERE user_id = $1 AND provider = $2`,
    [args.userId, args.provider],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Load the decrypted token bundle for a user/provider. Returns null
 * when no connection exists.
 *
 * Internal-only: production tool code goes through `SecretsContext`
 * (which calls `refreshIfNeeded`), not this. Exposed for the route
 * handlers that need to call provider-side revoke / cleanup.
 */
export async function loadDecryptedConnection(
  pool: Pool | PoolClient,
  args: { userId: UserId; provider: string },
  key: Buffer,
): Promise<(TokenBundle & { row: ConnectionRow }) | null> {
  const res = await pool.query<ConnectionRow>(
    `SELECT * FROM agent_user_connections WHERE user_id = $1 AND provider = $2`,
    [args.userId, args.provider],
  );
  const row = res.rows[0];
  if (!row) return null;
  const bundle = decryptBundle(
    { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag },
    key,
  );
  return { ...bundle, row };
}

// --------------------------------------------------------------------
// OAuth wire helpers
// --------------------------------------------------------------------

/**
 * Parse a standard RFC 6749 token endpoint response. Providers with
 * non-standard shapes (e.g. Slack) supply their own `parseTokenResponse`.
 */
function defaultParseTokenResponse(raw: unknown): ParsedTokenResponse {
  const r = (raw ?? {}) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof r.access_token !== "string" || r.access_token.length === 0) {
    throw new Error(`token endpoint response missing access_token: ${JSON.stringify(raw)}`);
  }
  const out: ParsedTokenResponse = { accessToken: r.access_token };
  if (typeof r.refresh_token === "string" && r.refresh_token.length > 0) {
    out.refreshToken = r.refresh_token;
  }
  if (typeof r.expires_in === "number") out.expiresIn = r.expires_in;
  if (typeof r.scope === "string" && r.scope.length > 0) {
    out.scopes = r.scope.split(/\s+/).filter(Boolean);
  }
  return out;
}

export interface BuildAuthorizeUrlArgs {
  provider: OAuthProviderConfig;
  clientId: string;
  redirectUri: string;
  state: string;
  /** Override scopes for this start. Defaults to provider.defaultScopes. */
  scopes?: string[];
}

export function buildAuthorizeUrl(args: BuildAuthorizeUrlArgs): string {
  const url = new URL(args.provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set("scope", (args.scopes ?? args.provider.defaultScopes).join(" "));
  for (const [k, v] of Object.entries(args.provider.extraAuthorizeParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export interface ExchangeCodeArgs {
  provider: OAuthProviderConfig;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export async function exchangeAuthorizationCode(
  args: ExchangeCodeArgs,
): Promise<ParsedTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(args.provider.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const raw = await readJsonOrThrow(res);
  const parsed = (args.provider.parseTokenResponse ?? defaultParseTokenResponse)(raw);
  if (!parsed.refreshToken && !args.provider.refreshTokenOptional) {
    throw new Error(
      `provider "${args.provider.id}" did not return a refresh_token. Check that scopes include offline access (e.g. Google's access_type=offline + prompt=consent, Microsoft's offline_access). If this provider deliberately doesn't issue refresh tokens (Notion's default flow, Stripe Connect, etc.), set refreshTokenOptional: true on its OAuthProviderConfig.`,
    );
  }
  return parsed;
}

export interface RefreshArgs {
  provider: OAuthProviderConfig;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

export async function refreshAccessToken(args: RefreshArgs): Promise<ParsedTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(args.provider.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const raw = await readJsonOrThrow(res);
  return (args.provider.parseTokenResponse ?? defaultParseTokenResponse)(raw);
}

async function readJsonOrThrow(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token endpoint returned ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `token endpoint returned non-JSON (${res.status}): ${text.slice(0, 500)} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

// --------------------------------------------------------------------
// SecretsContext — what tools see at call time
// --------------------------------------------------------------------

export interface ConnectionAccess {
  provider: string;
  /** Guaranteed fresh (refreshed if expiring within 60s). */
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
  accountLabel?: string;
}

export interface SecretsContext {
  /** Return the current connection or null if the user hasn't connected. */
  getConnection(provider: string): Promise<ConnectionAccess | null>;
  /** Same as `getConnection` but throws {@link NeedsConnectionError} on miss. */
  requireConnection(provider: string): Promise<ConnectionAccess>;
}

/**
 * Tool-friendly error thrown by `requireConnection` when the user hasn't
 * connected. `executeToolCall` already turns thrown errors into tool_result
 * blocks with `is_error: true`, so the model just sees the message and
 * can ask the user to visit /ui/connections — no special pause shape.
 */
export class NeedsConnectionError extends Error {
  constructor(
    public provider: string,
    public scopes: string[],
  ) {
    super(
      `Connection required for provider="${provider}" (scopes: ${scopes.join(", ")}). Ask the user to visit /ui/connections to connect this provider, then try the tool again.`,
    );
    this.name = "NeedsConnectionError";
  }
}

export interface BuildSecretsContextArgs {
  pool: Pool;
  userId: UserId | null;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Defaults to the global registry; tests can pass an explicit list. */
  providers?: OAuthProviderConfig[];
  /** Defaults to `getConnectionsEncryptionKey(env)`. */
  encryptionKey?: Buffer | null;
  fetchImpl?: typeof fetch;
}

/**
 * Build a per-run {@link SecretsContext}. The context closes over the
 * run's `userId` so a tool cannot ever request another tenant's
 * connections. Connection refresh-on-use is atomic: a `SELECT ... FOR
 * UPDATE` inside a transaction ensures two concurrent tools on the same
 * run share one refreshed token instead of racing.
 *
 * When the encryption key is unset or `userId` is null, every call
 * returns null / throws NeedsConnectionError. The web layer is expected
 * to surface "CONNECTIONS_ENCRYPTION_KEY not set" as a diagnostics warning
 * before any tool ever calls in.
 */
export function buildSecretsContext(args: BuildSecretsContextArgs): SecretsContext {
  const env = args.env ?? process.env;
  const providers = args.providers ?? listRegisteredOAuthProviders();
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const key = args.encryptionKey ?? getConnectionsEncryptionKey(env);
  const fetchImpl = args.fetchImpl ?? fetch;

  const resolve = async (providerId: string): Promise<ConnectionAccess | null> => {
    if (args.userId === null) return null;
    if (!key) return null;
    const provider = providerById.get(providerId);
    if (!provider) return null;
    return refreshAndLoad({
      pool: args.pool,
      userId: args.userId,
      provider,
      env,
      key,
      fetchImpl,
      ...(args.logger ? { logger: args.logger } : {}),
    });
  };

  return {
    async getConnection(providerId) {
      return resolve(providerId);
    },
    async requireConnection(providerId) {
      const access = await resolve(providerId);
      if (!access) {
        const provider = providerById.get(providerId);
        throw new NeedsConnectionError(providerId, provider?.defaultScopes ?? []);
      }
      return access;
    },
  };
}

/**
 * Atomic "load + maybe-refresh + persist + return access token" cycle.
 *
 * Runs inside a transaction with `SELECT ... FOR UPDATE` so two
 * concurrent tool calls on the same (user, provider) row don't both
 * fire a refresh and race-clobber each other's rotated refresh token.
 */
async function refreshAndLoad(args: {
  pool: Pool;
  userId: UserId;
  provider: OAuthProviderConfig;
  env: NodeJS.ProcessEnv;
  key: Buffer;
  fetchImpl: typeof fetch;
  logger?: Logger;
}): Promise<ConnectionAccess | null> {
  const { pool, userId, provider, env, key, fetchImpl, logger } = args;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<ConnectionRow>(
      `SELECT * FROM agent_user_connections
         WHERE user_id = $1 AND provider = $2
         FOR UPDATE`,
      [userId, provider.id],
    );
    const row = res.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const bundle = decryptBundle(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag },
      key,
    );

    const expiresAt = new Date(bundle.expiresAt);
    const needsRefresh = expiresAt.getTime() - Date.now() < REFRESH_LEAD_MS;
    if (!needsRefresh) {
      await client.query("COMMIT");
      return toAccess(provider.id, bundle);
    }
    // Providers with `refreshTokenOptional: true` (Notion's default
    // flow, etc.) don't issue refresh tokens, so refresh-on-use is a
    // no-op: return the stored access token unchanged. The eventual
    // provider-side 401 surfaces to the pack tool, which should tell
    // the user to reconnect.
    if (provider.refreshTokenOptional || !bundle.refreshToken) {
      await client.query("COMMIT");
      return toAccess(provider.id, bundle);
    }

    const clientId = env[provider.clientIdEnv];
    const clientSecret = env[provider.clientSecretEnv];
    if (!clientId || !clientSecret) {
      // Without app credentials we cannot refresh. Surface clearly — the
      // tool will get a NeedsConnectionError-like failure if it called
      // requireConnection, or null if getConnection.
      logger?.warn(
        {
          provider: provider.id,
          missing: [
            !clientId ? provider.clientIdEnv : null,
            !clientSecret ? provider.clientSecretEnv : null,
          ].filter(Boolean),
        },
        "connections: cannot refresh — provider OAuth client credentials missing",
      );
      await client.query("ROLLBACK");
      return null;
    }

    let refreshed: ParsedTokenResponse;
    try {
      refreshed = await refreshAccessToken({
        provider,
        clientId,
        clientSecret,
        refreshToken: bundle.refreshToken,
        fetchImpl,
      });
    } catch (err) {
      logger?.warn(
        { provider: provider.id, err: err instanceof Error ? err.message : String(err) },
        "connections: refresh failed",
      );
      await client.query("ROLLBACK");
      return null;
    }

    // If the provider rotated the refresh token (Microsoft, Slack-with-
    // rotation, etc.), persist the new one. Otherwise keep the existing
    // refresh token alive — Google and many others rotate only at re-consent.
    const nextRefresh = refreshed.refreshToken ?? bundle.refreshToken;
    const ttlSec = refreshed.expiresIn ?? 3600;
    const nextExpiry = new Date(Date.now() + ttlSec * 1000);
    const nextScopes = refreshed.scopes ?? bundle.scopes;
    const nextBundle: TokenBundle = {
      accessToken: refreshed.accessToken,
      refreshToken: nextRefresh,
      expiresAt: nextExpiry.toISOString(),
      scopes: nextScopes,
      ...(bundle.accountLabel ? { accountLabel: bundle.accountLabel } : {}),
    };
    const blob = encryptBundle(nextBundle, key);
    await client.query(
      `UPDATE agent_user_connections SET
         scopes = $3,
         ciphertext = $4,
         iv = $5,
         auth_tag = $6,
         expires_at = $7,
         updated_at = now()
         WHERE user_id = $1 AND provider = $2`,
      [userId, provider.id, nextScopes, blob.ciphertext, blob.iv, blob.authTag, nextExpiry],
    );
    await client.query("COMMIT");
    return toAccess(provider.id, nextBundle);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function toAccess(providerId: string, bundle: TokenBundle): ConnectionAccess {
  const out: ConnectionAccess = {
    provider: providerId,
    accessToken: bundle.accessToken,
    expiresAt: new Date(bundle.expiresAt),
    scopes: bundle.scopes,
  };
  if (bundle.accountLabel) out.accountLabel = bundle.accountLabel;
  return out;
}
