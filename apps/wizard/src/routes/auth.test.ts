import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../store.js";
import { registerAuthRoutes } from "./auth.js";

const SECRET = "session-secret";
const CLIENT_ID = "Iv1.abc";
const CLIENT_SECRET = "shhh";
const PUBLIC_URL = "http://localhost:8090";

function makeApp(opts: { fetchImpl: typeof fetch }) {
  const store = createMemoryStore();
  const app = new Hono();
  registerAuthRoutes(app, {
    store,
    sessionSecret: SECRET,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicUrl: PUBLIC_URL,
    fetchImpl: opts.fetchImpl,
  });
  return { app, store };
}

describe("auth routes", () => {
  it("/api/auth/login redirects to GitHub with a state token", async () => {
    const fetchImpl = vi.fn();
    const { app } = makeApp({ fetchImpl });
    const res = await app.request("/api/auth/login?next=/my");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("https://github.com/login/oauth/authorize");
    expect(loc).toContain(`client_id=${encodeURIComponent(CLIENT_ID)}`);
    expect(loc).toContain("state=");
    expect(loc).toContain("redirect_uri=");
  });

  it("/api/auth/callback exchanges code -> user, upserts, sets cookie, redirects to next", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "user-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("api.github.com/user")) {
        return new Response(
          JSON.stringify({ id: 42, login: "alice", name: "Alice", avatar_url: "x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { app, store } = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });

    // Build a valid state token by hitting /api/auth/login first.
    const loginRes = await app.request("/api/auth/login?next=/my");
    const stateMatch = loginRes.headers.get("location")?.match(/[?&]state=([^&]+)/);
    const state = decodeURIComponent(stateMatch?.[1] ?? "");
    expect(state).toBeTruthy();

    const res = await app.request(`/api/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/my");
    expect(res.headers.get("set-cookie")).toContain("rh_wizard_session=");

    const user = await store.getUser(42);
    expect(user?.login).toBe("alice");
  });

  it("/api/auth/me 401 without session", async () => {
    const { app } = makeApp({ fetchImpl: vi.fn() });
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(401);
  });
});
