import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAgentAddRoute } from "./agent-add.js";

const WIZARD_URL = "https://wizard.example.test";

function makeApp(overrides?: {
  fetchImpl?: typeof fetch;
  wizardServiceUrl?: string | null;
  wizardSharedSecret?: string | null;
  authReturn?: string | null;
  cacheTtlMs?: number;
}) {
  const app = new Hono();
  registerAgentAddRoute(app, {
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

describe("GET /agents/catalog (proxy)", () => {
  it("forwards the wizard's response body verbatim on success", async () => {
    const wizardBody = JSON.stringify({
      agents: [
        {
          bundleSlug: "chat",
          bundleName: "Chat",
          agentId: "chat-agent",
          description: "x",
          runtimeKinds: ["web"],
          capabilities: [],
          envVars: [],
          workflowTask: false,
        },
      ],
    });
    const fetchImpl = vi.fn(
      async () => new Response(wizardBody, { status: 200 }),
    ) as unknown as typeof fetch;
    const app = makeApp({ fetchImpl, cacheTtlMs: 0 });
    const res = await app.request("/agents/catalog");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(wizardBody);
    const callArg = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg).toBe(`${WIZARD_URL}/api/agents/catalog`);
  });

  it("401s unauthenticated callers without touching the wizard", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const app = makeApp({ authReturn: null, fetchImpl });
    const res = await app.request("/agents/catalog");
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("503s when the wizard URL is unset", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const app = makeApp({ wizardServiceUrl: null, fetchImpl });
    const res = await app.request("/agents/catalog");
    expect(res.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("502s on wizard error and forwards details", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("upstream boom", { status: 500 }),
    ) as unknown as typeof fetch;
    const app = makeApp({ fetchImpl, cacheTtlMs: 0 });
    const res = await app.request("/agents/catalog");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; status: number; details: string };
    expect(body.error).toBe("wizard_catalog_failed");
    expect(body.status).toBe(500);
    expect(body.details).toBe("upstream boom");
  });

  it("caches successful responses within the TTL window", async () => {
    const wizardBody = JSON.stringify({ agents: [] });
    const fetchImpl = vi.fn(
      async () => new Response(wizardBody, { status: 200 }),
    ) as unknown as typeof fetch;
    const app = makeApp({ fetchImpl, cacheTtlMs: 60_000 });
    const r1 = await app.request("/agents/catalog");
    const r2 = await app.request("/agents/catalog");
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
    await app.request("/agents/catalog");
    await app.request("/agents/catalog");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

describe("POST /agents/add (proxy)", () => {
  it("forwards body + locator to the wizard with the shared-secret bearer", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, changedFiles: ["render-harness.yaml"] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const app = new Hono();
    registerAgentAddRoute(app, {
      auth: async () => "u1",
      agents: {},
      pathPrefix: "",
      wizardServiceUrl: WIZARD_URL,
      wizardSharedSecret: "secret",
      deployment: {
        name: "n",
        agents: [],
        repoLocator: { org: "render-lab", repo: "harness", installationId: "42" },
      },
      fetchImpl,
    });
    const res = await app.request("/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleSlug: "chat", agentId: "chat-agent" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(call[0]).toBe(`${WIZARD_URL}/api/agents/add`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      bundleSlug: "chat",
      agentId: "chat-agent",
      org: "render-lab",
      repo: "harness",
      installationId: "42",
    });
  });

  it("409s with needs_install when installationId is missing", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const app = new Hono();
    registerAgentAddRoute(app, {
      auth: async () => "u1",
      agents: {},
      pathPrefix: "",
      wizardServiceUrl: WIZARD_URL,
      wizardSharedSecret: "secret",
      deployment: {
        name: "n",
        agents: [],
        repoLocator: { org: "render-lab", repo: "harness", installationId: null },
      },
      fetchImpl,
    });
    const res = await app.request("/agents/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleSlug: "chat", agentId: "chat-agent" }),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; installUrl: string };
    expect(json.error).toBe("needs_install");
    expect(json.installUrl).toContain(WIZARD_URL);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
