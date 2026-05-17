import { describe, expect, it } from "vitest";
import { authRequestForBearer, buildCookieConfig } from "./auth.js";

describe("buildCookieConfig", () => {
  it("uses UI_COOKIE_SECRET env when no explicit secret is given", () => {
    const prev = process.env.UI_COOKIE_SECRET;
    process.env.UI_COOKIE_SECRET = "from-env";
    try {
      const cfg = buildCookieConfig({});
      expect(cfg.secret).toBe("from-env");
    } finally {
      if (prev === undefined) delete process.env.UI_COOKIE_SECRET;
      else process.env.UI_COOKIE_SECRET = prev;
    }
  });

  it("falls back to a per-process random secret when nothing is provided", () => {
    const prev = process.env.UI_COOKIE_SECRET;
    delete process.env.UI_COOKIE_SECRET;
    try {
      const cfg = buildCookieConfig({});
      expect(cfg.secret).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      if (prev !== undefined) process.env.UI_COOKIE_SECRET = prev;
    }
  });

  it("treats empty UI_COOKIE_SECRET as missing", () => {
    const prev = process.env.UI_COOKIE_SECRET;
    process.env.UI_COOKIE_SECRET = "";
    try {
      const cfg = buildCookieConfig({});
      expect(cfg.secret).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      if (prev === undefined) delete process.env.UI_COOKIE_SECRET;
      else process.env.UI_COOKIE_SECRET = prev;
    }
  });

  it("respects explicit overrides", () => {
    const cfg = buildCookieConfig({
      cookieName: "custom",
      secret: "explicit",
      maxAge: 60,
      secure: false,
    });
    expect(cfg.cookieName).toBe("custom");
    expect(cfg.secret).toBe("explicit");
    expect(cfg.maxAge).toBe(60);
    expect(cfg.secure).toBe(false);
  });
});

describe("authRequestForBearer", () => {
  it("forges a Request that carries the API key as a bearer header", () => {
    const req = authRequestForBearer("k1");
    expect(req.headers.get("authorization")).toBe("Bearer k1");
  });
});
