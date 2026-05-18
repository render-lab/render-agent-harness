import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerCapabilityInstallRoute } from "./capability-install.js";

const WIZARD_URL = "https://wizard.example.test";

function makeApp(overrides?: {
  fetchImpl?: typeof fetch;
  wizardServiceUrl?: string | null;
  wizardSharedSecret?: string | null;
  authReturn?: string | null;
  cacheTtlMs?: number;
}) {
  const app = new Hono();
  registerCapabilityInstallRoute(app, {
    auth: async () => (overrides?.authReturn === undefined ? "u1" : overrides.authReturn),
    agents: {},
    pathPrefix: "",
    wizardServiceUrl:
      overrides?.wizardServiceUrl === undefined ? WIZARD_URL : overrides.wizardServiceUrl,
    wizardSharedSecret:
      overrides?.wizardSharedSecret === undefined ? "secret" : overrides.wizardSharedSecret,
    fetchImpl: overrides?.fetchImpl ?? (vi.fn() as unknown as typeof fetch),
    ...(overrides?.cacheTtlMs !== undefined ? { catalogCacheTtlMs: overrides.cacheTtlMs } : {}),
  });
  return app;
}

describe("GET /capabilities/catalog (proxy)", () => {
  it("forwards the wizard's response body verbatim on success", async () => {
    const wizardBody = JSON.stringify({
      capabilities: [
        {
          pack: "@render-harness/cap-search-exa",
          label: "Exa web search",
          description: "Exa MCP",
          envVars: ["EXA_API_KEY"],
          hasWriteTools: false,
          isConnector: false,
          caveat: null,
        },
      ],
    });
    const fetchImpl = vi.fn(
      async () => new Response(wizardBody, { status: 200 }),
    ) as unknown as typeof fetch;
    const app = makeApp({ fetchImpl, cacheTtlMs: 0 });
    const res = await app.request("/capabilities/catalog");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(wizardBody);
    const callArg = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg).toBe(`${WIZARD_URL}/api/capabilities/catalog`);
  });

  it("401s unauthenticated callers without touching the wizard", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const app = makeApp({ authReturn: null, fetchImpl });
    const res = await app.request("/capabilities/catalog");
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("503s when the wizard URL is unset", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const app = makeApp({ wizardServiceUrl: null, fetchImpl });
    const res = await app.request("/capabilities/catalog");
    expect(res.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("502s on wizard error and forwards details", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("upstream boom", { status: 500 }),
    ) as unknown as typeof fetch;
    const app = makeApp({ fetchImpl, cacheTtlMs: 0 });
    const res = await app.request("/capabilities/catalog");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; status: number; details: string };
    expect(body.error).toBe("wizard_catalog_failed");
    expect(body.status).toBe(500);
    expect(body.details).toBe("upstream boom");
  });

  it("caches successful responses within the TTL window", async () => {
    const wizardBody = JSON.stringify({ capabilities: [] });
    const fetchImpl = vi.fn(
      async () => new Response(wizardBody, { status: 200 }),
    ) as unknown as typeof fetch;
    const app = makeApp({ fetchImpl, cacheTtlMs: 60_000 });
    const r1 = await app.request("/capabilities/catalog");
    const r2 = await app.request("/capabilities/catalog");
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(r2.headers.get("x-cache")).toBe("HIT");
  });

  it("does not cache failures", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    const app = makeApp({ fetchImpl, cacheTtlMs: 60_000 });
    await app.request("/capabilities/catalog");
    await app.request("/capabilities/catalog");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});
