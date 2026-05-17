import type { DeploymentInfo } from "@render-harness/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerVitalsRoutes } from "./vitals.js";

const DEPLOYMENT: DeploymentInfo = {
  name: "test",
  agents: [],
  renderService: { serviceId: "srv-abc123", apiKeyConfigured: true },
  operatorFeatures: { vitals: { enabled: true, missing: [] } },
};

function makeApp(overrides?: {
  deployment?: DeploymentInfo | undefined;
  fetchImpl?: typeof fetch;
  authReturn?: string | null;
}) {
  const app = new Hono();
  registerVitalsRoutes(app, {
    auth: async () => (overrides?.authReturn === undefined ? "u1" : overrides.authReturn),
    deployment: overrides?.deployment === undefined ? DEPLOYMENT : overrides.deployment,
    pathPrefix: "",
    renderApiBase: "https://api.render.test",
    fetchImpl: overrides?.fetchImpl ?? (vi.fn() as unknown as typeof fetch),
  });
  return app;
}

describe("GET /vitals", () => {
  beforeEach(() => {
    process.env.RENDER_API_KEY = "rnd_test";
  });
  afterEach(() => {
    delete process.env.RENDER_API_KEY;
  });

  it("proxies instances and metrics from the Render API", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/instances") {
        return jsonResponse({
          instances: [
            {
              instance: {
                id: "inst-1",
                name: "web-1",
                status: "running",
                createdAt: "2026-05-17T10:00:00.000Z",
              },
            },
          ],
        });
      }
      return jsonResponse({
        data: [
          {
            points: [{ timestamp: "2026-05-17T10:00:00.000Z", value: 42 }],
          },
        ],
      });
    });

    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/vitals?rangeMinutes=30&resolutionSeconds=30");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      serviceId: string;
      instances: Array<{ id: string; status: string }>;
      metrics: Array<{ kind: string; points: Array<{ value: number }> }>;
    };
    expect(body.serviceId).toBe("srv-abc123");
    expect(body.instances[0]).toMatchObject({ id: "inst-1", status: "running" });
    expect(body.metrics.map((m) => m.kind)).toEqual(["cpu", "memory", "httpLatencyP95"]);
    expect(body.metrics[0]?.points[0]?.value).toBe(42);

    const urls = fetchImpl.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls.some((url) => url.pathname === "/v1/instances")).toBe(true);
    expect(urls.some((url) => url.pathname === "/v1/metrics/cpu")).toBe(true);
    expect(urls.some((url) => url.searchParams.get("resource") === "srv-abc123")).toBe(true);
  });

  it("401s without an authenticated user", async () => {
    const app = makeApp({ authReturn: null });
    const res = await app.request("/vitals");
    expect(res.status).toBe(401);
  });

  it("404s when the vitals feature flag is disabled", async () => {
    const app = makeApp({
      deployment: {
        ...DEPLOYMENT,
        operatorFeatures: { vitals: { enabled: false, missing: [] } },
      },
    });
    const res = await app.request("/vitals");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("vitals_disabled");
  });

  it("503s when RENDER_SERVICE_ID is missing", async () => {
    const app = makeApp({
      deployment: { ...DEPLOYMENT, renderService: { serviceId: null, apiKeyConfigured: true } },
    });
    const res = await app.request("/vitals");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("render_service_not_configured");
  });

  it("503s when RENDER_API_KEY is missing", async () => {
    delete process.env.RENDER_API_KEY;
    const app = makeApp();
    const res = await app.request("/vitals");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("render_api_key_not_configured");
  });

  it("surfaces Render API errors as 502", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/vitals");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; status: number };
    expect(body.error).toBe("render_api_error");
    expect(body.status).toBe(429);
  });
});

describe("GET /vitals/logs", () => {
  beforeEach(() => {
    process.env.RENDER_API_KEY = "rnd_test";
    process.env.RENDER_OWNER_ID = "own-123";
  });
  afterEach(() => {
    delete process.env.RENDER_API_KEY;
    delete process.env.RENDER_OWNER_ID;
  });

  it("proxies logs from the Render API", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        logs: [
          {
            id: "log-1",
            timestamp: "2026-05-17T10:00:00.000Z",
            message: "hello",
            level: "info",
            type: "app",
            method: "GET",
            path: "/healthz",
            statusCode: 200,
          },
        ],
        nextCursor: "next",
      }),
    );
    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/vitals/logs?level=info&text=hello&limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: Array<{ id: string; statusCode: string }>;
      nextCursor: string | null;
    };
    expect(body.logs[0]).toMatchObject({ id: "log-1", statusCode: "200" });
    expect(body.nextCursor).toBe("next");

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/logs");
    expect(url.searchParams.get("ownerId")).toBe("own-123");
    expect(url.searchParams.get("resource")).toBe("srv-abc123");
    expect(url.searchParams.get("level")).toBe("info");
    expect(url.searchParams.get("text")).toBe("hello");
  });

  it("503s when RENDER_OWNER_ID is missing", async () => {
    delete process.env.RENDER_OWNER_ID;
    const app = makeApp();
    const res = await app.request("/vitals/logs");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("render_owner_not_configured");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
