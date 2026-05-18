/**
 * HTTP-level integration tests for /connections.
 *
 * Spins up the Hono app against a live Postgres (skipped if unreachable).
 * Outbound OAuth calls (token exchange, userinfo, revoke, refresh) are
 * stubbed via the `fetchImpl` injection point so the tests run offline.
 */

import { randomBytes } from "node:crypto";
import {
  _clearOAuthProviderRegistryForTests,
  applyMigrations,
  buildLogger,
  buildSecretsContext,
  closeSharedPool,
  createPool,
  getConnectionsEncryptionKey,
  type OAuthProviderConfig,
  type Pool,
  registerOAuthProvider,
  type UserId,
} from "@render-harness/core";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerConnectionsRoutes } from "./connections.js";

const CONN = process.env.TEST_DATABASE_URL ?? "postgres://harness:harness@127.0.0.1:55432/harness";

let pool: Pool | null = null;

beforeAll(async () => {
  try {
    pool = createPool({ connectionString: CONN, applicationName: "web-connections-it" });
    await pool.query("SELECT 1");
    await applyMigrations(pool);
  } catch {
    pool = null;
  }
});

afterAll(async () => {
  await pool?.end();
  await closeSharedPool();
});

const KEY = randomBytes(32).toString("base64");
const STATE_SECRET = "test-state-secret-xyzzy";
const PUBLIC_URL = "http://localhost:8080";

const GOOGLE: OAuthProviderConfig = {
  id: "google",
  displayName: "Google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  clientIdEnv: "TEST_GOOGLE_CLIENT_ID",
  clientSecretEnv: "TEST_GOOGLE_CLIENT_SECRET",
  defaultScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  fetchAccountLabel: async () => "test@example.com",
};

interface FakeFetchCall {
  url: string;
  method: string;
  body?: string;
}

function buildApp(opts: {
  db: Pool;
  fakeResponses?: Map<string, () => Response>;
  capturedCalls?: FakeFetchCall[];
}) {
  const auth = async (req: Request) => {
    const u = req.headers.get("x-test-user");
    return (u && u.length > 0 ? u : null) as UserId | null;
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? init.body : undefined;
    opts.capturedCalls?.push({ url, method, ...(body !== undefined ? { body } : {}) });
    const responder = opts.fakeResponses?.get(url);
    if (responder) return responder();
    return new Response("not-stubbed", { status: 500 });
  };

  const app = new Hono();
  registerConnectionsRoutes(app, {
    pool: opts.db,
    auth,
    logger: buildLogger({ level: "silent" }),
    pathPrefix: "",
    publicUrl: PUBLIC_URL,
    stateSecret: STATE_SECRET,
    fetchImpl,
  });
  return app;
}

const dbTest = (name: string, fn: (db: Pool) => Promise<void>) => {
  it(name, async () => {
    if (!pool) {
      console.warn(`[skip] ${name}: no Postgres reachable at ${CONN}`);
      return;
    }
    await fn(pool);
  });
};

beforeEach(() => {
  _clearOAuthProviderRegistryForTests();
  process.env.CONNECTIONS_ENCRYPTION_KEY = KEY;
  process.env.TEST_GOOGLE_CLIENT_ID = "test-client-id";
  process.env.TEST_GOOGLE_CLIENT_SECRET = "test-client-secret";
  registerOAuthProvider(GOOGLE);
});

afterEach(async () => {
  delete process.env.CONNECTIONS_ENCRYPTION_KEY;
  delete process.env.TEST_GOOGLE_CLIENT_ID;
  delete process.env.TEST_GOOGLE_CLIENT_SECRET;
  _clearOAuthProviderRegistryForTests();
  if (pool) await pool.query("DELETE FROM agent_user_connections");
});

describe("GET /connections (empty registry)", () => {
  // Regression: support-bot-style harness (no OAuth packs) was hitting
  // 404 on /connections because `mountConnectionsRoutes` short-circuited
  // when `listRegisteredOAuthProviders()` returned empty. The SPA catch-
  // all in front of the static UI bundle then returned HTML, and
  // `request<T>()` correctly threw "server returned non-JSON for
  // /connections". The route now mounts unconditionally; this test
  // pins the new behavior so the early-return doesn't sneak back in.
  dbTest(
    "returns 200 with empty providers + connections when no pack registers OAuth",
    async (db) => {
      _clearOAuthProviderRegistryForTests();
      const app = buildApp({ db });
      const res = await app.fetch(
        new Request("http://x/connections", { headers: { "x-test-user": "u-empty" } }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await res.json()) as { providers: unknown[]; connections: unknown[] };
      expect(body.providers).toEqual([]);
      expect(body.connections).toEqual([]);
    },
  );
});

describe("GET /connections", () => {
  dbTest("401 unauthenticated", async (db) => {
    const app = buildApp({ db });
    const res = await app.fetch(new Request("http://x/connections"));
    expect(res.status).toBe(401);
  });

  dbTest("returns providers + empty connections for a fresh user", async (db) => {
    const app = buildApp({ db });
    const res = await app.fetch(
      new Request("http://x/connections", { headers: { "x-test-user": "u-1" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; clientCredentialsConfigured: boolean }>;
      connections: unknown[];
    };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]?.id).toBe("google");
    expect(body.providers[0]?.clientCredentialsConfigured).toBe(true);
    expect(body.connections).toEqual([]);
  });

  dbTest("includes the caller's own connection but not other users'", async (db) => {
    const app = buildApp({ db });
    // Seed: simulate "u-other" connected, "u-self" not.
    const key = getConnectionsEncryptionKey(process.env);
    if (!key) throw new Error("key missing");
    const { upsertConnection } = await import("@render-harness/core");
    await upsertConnection(
      db,
      {
        userId: "u-other",
        provider: "google",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: ["scope-a"],
        accountLabel: "other@example.com",
      },
      key,
    );

    const res = await app.fetch(
      new Request("http://x/connections", { headers: { "x-test-user": "u-self" } }),
    );
    const body = (await res.json()) as { connections: unknown[] };
    expect(body.connections).toEqual([]);

    const res2 = await app.fetch(
      new Request("http://x/connections", { headers: { "x-test-user": "u-other" } }),
    );
    const body2 = (await res2.json()) as {
      connections: Array<{ provider: string; accountLabel: string | null }>;
    };
    expect(body2.connections).toHaveLength(1);
    expect(body2.connections[0]?.provider).toBe("google");
    expect(body2.connections[0]?.accountLabel).toBe("other@example.com");
  });
});

describe("POST /connections/:provider/start", () => {
  dbTest("401 unauthenticated", async (db) => {
    const app = buildApp({ db });
    const res = await app.fetch(
      new Request("http://x/connections/google/start", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  dbTest("404 unknown provider", async (db) => {
    const app = buildApp({ db });
    const res = await app.fetch(
      new Request("http://x/connections/notreal/start", {
        method: "POST",
        headers: { "x-test-user": "u-1" },
      }),
    );
    expect(res.status).toBe(404);
  });

  dbTest("503 when client credentials are missing", async (db) => {
    delete process.env.TEST_GOOGLE_CLIENT_ID;
    const app = buildApp({ db });
    const res = await app.fetch(
      new Request("http://x/connections/google/start", {
        method: "POST",
        headers: { "x-test-user": "u-1" },
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("oauth_not_configured");
  });

  dbTest("503 when encryption key is missing", async (db) => {
    delete process.env.CONNECTIONS_ENCRYPTION_KEY;
    const app = buildApp({ db });
    const res = await app.fetch(
      new Request("http://x/connections/google/start", {
        method: "POST",
        headers: { "x-test-user": "u-1" },
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("connections_key_not_set");
  });

  dbTest("returns an authorize URL carrying state + scopes + redirect", async (db) => {
    const app = buildApp({ db });
    const res = await app.fetch(
      new Request("http://x/connections/google/start", {
        method: "POST",
        headers: { "x-test-user": "u-1" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl: string; provider: string };
    expect(body.provider).toBe("google");
    const url = new URL(body.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/connections/google/callback`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")?.split(".").length).toBe(2);
  });
});

describe("GET /connections/:provider/callback", () => {
  dbTest("rejects invalid state", async (db) => {
    const app = buildApp({ db });
    const res = await app.fetch(
      new Request("http://x/connections/google/callback?code=abc&state=garbage"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_state");
  });

  dbTest("exchanges code, encrypts, persists, and 302s to UI", async (db) => {
    const captured: FakeFetchCall[] = [];
    const fakeResponses = new Map<string, () => Response>();
    fakeResponses.set("https://oauth2.googleapis.com/token", () =>
      Response.json({
        access_token: "ya29.a0ARrdaM",
        refresh_token: "1//refresh-from-callback",
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        token_type: "Bearer",
      }),
    );
    const app = buildApp({ db, fakeResponses, capturedCalls: captured });

    // Drive the real start path to get a valid signed state.
    const startRes = await app.fetch(
      new Request("http://x/connections/google/start", {
        method: "POST",
        headers: { "x-test-user": "u-cb-1" },
      }),
    );
    const startBody = (await startRes.json()) as { authorizeUrl: string };
    const state = new URL(startBody.authorizeUrl).searchParams.get("state");
    if (!state) throw new Error("state missing");

    const cbRes = await app.fetch(
      new Request(
        `http://x/connections/google/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      ),
      { redirect: "manual" } as never,
    );
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toContain("#/connections?connected=google");

    // Token-exchange request was issued.
    const tokenCall = captured.find((c) => c.url === "https://oauth2.googleapis.com/token");
    expect(tokenCall).toBeDefined();
    expect(tokenCall?.method).toBe("POST");
    expect(tokenCall?.body).toContain("grant_type=authorization_code");
    expect(tokenCall?.body).toContain("code=auth-code-1");

    // Persistence check: the row exists and is keyed to the right user.
    const row = await db.query(
      "SELECT user_id, provider, scopes, account_label, expires_at FROM agent_user_connections WHERE user_id = $1",
      ["u-cb-1"],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]?.provider).toBe("google");
    expect(row.rows[0]?.account_label).toBe("test@example.com");
    expect(row.rows[0]?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);

    // SecretsContext returns the decrypted access token to a tool.
    const secrets = buildSecretsContext({
      pool: db,
      userId: "u-cb-1",
      env: process.env,
    });
    const access = await secrets.requireConnection("google");
    expect(access.accessToken).toBe("ya29.a0ARrdaM");
    expect(access.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  });

  dbTest("refresh-on-use refreshes when access token is near expiry", async (db) => {
    // Seed an expired connection directly.
    const key = getConnectionsEncryptionKey(process.env);
    if (!key) throw new Error("key missing");
    const { upsertConnection } = await import("@render-harness/core");
    await upsertConnection(
      db,
      {
        userId: "u-refresh",
        provider: "google",
        accessToken: "stale",
        refreshToken: "1//refresh-stored",
        expiresAt: new Date(Date.now() - 1000), // already expired
        scopes: ["scope-a"],
      },
      key,
    );

    const captured: FakeFetchCall[] = [];
    const fakeResponses = new Map<string, () => Response>();
    fakeResponses.set("https://oauth2.googleapis.com/token", () =>
      Response.json({
        access_token: "ya29.NEW",
        // Google does NOT rotate the refresh token; the new bundle keeps
        // the stored one.
        expires_in: 3600,
        scope: "scope-a",
        token_type: "Bearer",
      }),
    );
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      captured.push({ url, method, ...(body !== undefined ? { body } : {}) });
      const responder = fakeResponses.get(url);
      if (responder) return responder();
      return new Response("not-stubbed", { status: 500 });
    };

    const secrets = buildSecretsContext({
      pool: db,
      userId: "u-refresh",
      env: process.env,
      fetchImpl,
    });
    const access = await secrets.requireConnection("google");
    expect(access.accessToken).toBe("ya29.NEW");

    // Refresh-grant request was issued.
    const refreshCall = captured.find((c) => c.body?.includes("grant_type=refresh_token"));
    expect(refreshCall).toBeDefined();
    expect(refreshCall?.body).toContain("refresh_token=1%2F%2Frefresh-stored");

    // Row was updated: new expires_at is in the future.
    const row = await db.query<{ expires_at: Date }>(
      "SELECT expires_at FROM agent_user_connections WHERE user_id = $1",
      ["u-refresh"],
    );
    const expiresAt = row.rows[0]?.expires_at;
    if (!(expiresAt instanceof Date)) throw new Error("expires_at not a Date");
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  dbTest("refresh-on-use persists rotated refresh tokens", async (db) => {
    const key = getConnectionsEncryptionKey(process.env);
    if (!key) throw new Error("key missing");
    const { upsertConnection, loadDecryptedConnection } = await import("@render-harness/core");
    await upsertConnection(
      db,
      {
        userId: "u-rot",
        provider: "google",
        accessToken: "stale",
        refreshToken: "1//refresh-OLD",
        expiresAt: new Date(Date.now() - 1000),
        scopes: ["scope-a"],
      },
      key,
    );

    const fakeResponses = new Map<string, () => Response>();
    fakeResponses.set("https://oauth2.googleapis.com/token", () =>
      Response.json({
        access_token: "ya29.NEW",
        refresh_token: "1//refresh-NEW",
        expires_in: 3600,
        scope: "scope-a",
        token_type: "Bearer",
      }),
    );
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const responder = fakeResponses.get(url);
      if (responder) return responder();
      return new Response("not-stubbed", { status: 500 });
    };

    const secrets = buildSecretsContext({
      pool: db,
      userId: "u-rot",
      env: process.env,
      fetchImpl,
    });
    await secrets.requireConnection("google");

    const bundle = await loadDecryptedConnection(db, { userId: "u-rot", provider: "google" }, key);
    expect(bundle?.refreshToken).toBe("1//refresh-NEW");
  });
});

describe("DELETE /connections/:provider", () => {
  dbTest("401 unauthenticated", async (db) => {
    const app = buildApp({ db });
    const res = await app.fetch(new Request("http://x/connections/google", { method: "DELETE" }));
    expect(res.status).toBe(401);
  });

  dbTest("removes the row and attempts provider-side revoke", async (db) => {
    const key = getConnectionsEncryptionKey(process.env);
    if (!key) throw new Error("key missing");
    const { upsertConnection } = await import("@render-harness/core");
    await upsertConnection(
      db,
      {
        userId: "u-del",
        provider: "google",
        accessToken: "at-to-revoke",
        refreshToken: "rt",
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: ["scope-a"],
      },
      key,
    );

    const captured: FakeFetchCall[] = [];
    const fakeResponses = new Map<string, () => Response>();
    fakeResponses.set("https://oauth2.googleapis.com/revoke", () =>
      Response.json({}, { status: 200 }),
    );
    const app = buildApp({ db, fakeResponses, capturedCalls: captured });

    const res = await app.fetch(
      new Request("http://x/connections/google", {
        method: "DELETE",
        headers: { "x-test-user": "u-del" },
      }),
    );
    expect(res.status).toBe(200);
    const revokeCall = captured.find((c) => c.url === "https://oauth2.googleapis.com/revoke");
    expect(revokeCall).toBeDefined();
    expect(revokeCall?.body).toContain("token=at-to-revoke");

    const row = await db.query("SELECT 1 FROM agent_user_connections WHERE user_id = $1", [
      "u-del",
    ]);
    expect(row.rowCount).toBe(0);
  });
});
