import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
  signOAuthState,
  verifyOAuthState,
} from "./auth.js";

const SECRET = "session-secret-1";

describe("OAuth state round-trip", () => {
  it("signs and verifies a state token", () => {
    const token = signOAuthState(SECRET, "/my");
    const claims = verifyOAuthState(SECRET, token);
    expect(claims.next).toBe("/my");
    expect(typeof claims.exp).toBe("number");
  });

  it("rejects a state token signed with a different secret", () => {
    const token = signOAuthState("secret-A", "/my");
    expect(() => verifyOAuthState("secret-B", token)).toThrow();
  });

  it("rejects a malformed token", () => {
    expect(() => verifyOAuthState(SECRET, "not.a.token")).toThrow();
  });
});

/**
 * Cookie helpers are thin wrappers around `hono/cookie`. We test them
 * through a real Hono request/response round-trip rather than mocking
 * the Context internals.
 */
describe("session cookie (via real Hono app)", () => {
  function makeApp() {
    const app = new Hono();
    app.get("/set", (c) => {
      setSessionCookie(c, SECRET, 12345);
      return c.text("ok");
    });
    app.get("/me", (c) => {
      const claims = readSessionCookie(c, SECRET);
      return c.json({ id: claims?.githubUserId ?? null });
    });
    app.get("/clear", (c) => {
      clearSessionCookie(c);
      return c.text("ok");
    });
    return app;
  }

  it("readSessionCookie reads what setSessionCookie wrote", async () => {
    const app = makeApp();
    const setRes = await app.request("/set");
    const setCookie = setRes.headers.get("set-cookie") ?? "";
    const value = setCookie.split(";")[0] ?? "";
    expect(value).toContain("rh_wizard_session=");
    const meRes = await app.request("/me", { headers: { cookie: value } });
    const json = (await meRes.json()) as { id: number | null };
    expect(json.id).toBe(12345);
  });

  it("readSessionCookie returns null for missing cookie", async () => {
    const app = makeApp();
    const res = await app.request("/me");
    const json = (await res.json()) as { id: number | null };
    expect(json.id).toBeNull();
  });

  it("readSessionCookie returns null when secret differs", async () => {
    const app = new Hono();
    app.get("/set", (c) => {
      setSessionCookie(c, "secret-A", 99);
      return c.text("ok");
    });
    app.get("/me-other", (c) => {
      const claims = readSessionCookie(c, "secret-B");
      return c.json({ id: claims?.githubUserId ?? null });
    });
    const setRes = await app.request("/set");
    const value = setRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    const meRes = await app.request("/me-other", { headers: { cookie: value } });
    expect(((await meRes.json()) as { id: number | null }).id).toBeNull();
  });

  it("clearSessionCookie writes a Max-Age=0 cookie", async () => {
    const app = makeApp();
    const res = await app.request("/clear");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(/max-age=0/i.test(setCookie)).toBe(true);
  });
});
