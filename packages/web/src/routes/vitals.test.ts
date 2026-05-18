import type { DeploymentInfo } from "@render-harness/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetVitalsSiblingCache, registerVitalsRoutes } from "./vitals.js";

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
    __resetVitalsSiblingCache();
  });
  afterEach(() => {
    delete process.env.RENDER_API_KEY;
  });

  it("proxies instances and metrics from the Render API", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/services/srv-abc123/instances") {
        return jsonResponse([
          {
            id: "inst-1",
            createdAt: "2026-05-17T10:00:00.000Z",
          },
        ]);
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
      instances: Array<{ id: string; createdAt: string | null }>;
      metrics: Array<{ kind: string; points: Array<{ value: number }> }>;
    };
    expect(body.serviceId).toBe("srv-abc123");
    expect(body.instances[0]).toMatchObject({
      id: "inst-1",
      createdAt: "2026-05-17T10:00:00.000Z",
    });
    expect(body.metrics.map((m) => m.kind)).toEqual(["cpu", "memory", "httpLatencyP95"]);
    expect(body.metrics[0]?.points[0]?.value).toBe(42);

    const urls = fetchImpl.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls.some((url) => url.pathname === "/v1/services/srv-abc123/instances")).toBe(true);
    expect(urls.some((url) => url.pathname === "/v1/metrics/cpu")).toBe(true);
    expect(urls.some((url) => url.searchParams.get("resource") === "srv-abc123")).toBe(true);
    // Without ?serviceId= the route must not bother resolving siblings.
    expect(urls.some((url) => url.pathname === "/v1/services" && !url.search.includes("123"))).toBe(
      false,
    );
  });

  it("queries the requested sibling service when ?serviceId= is set", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/services/srv-abc123" && !url.search) {
        return jsonResponse({
          id: "srv-abc123",
          name: "web",
          type: "web_service",
          environmentId: "env-1",
        });
      }
      if (url.pathname === "/v1/services") {
        return jsonResponse([
          {
            service: { id: "srv-abc123", name: "web", type: "web_service", environmentId: "env-1" },
            cursor: "a",
          },
          {
            service: {
              id: "srv-worker",
              name: "worker",
              type: "background_worker",
              environmentId: "env-1",
            },
            cursor: "b",
          },
        ]);
      }
      if (url.pathname === "/v1/services/srv-worker/instances") {
        return jsonResponse([{ id: "inst-w1" }]);
      }
      return jsonResponse({ data: [{ points: [] }] });
    });

    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/vitals?serviceId=srv-worker");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serviceId: string };
    expect(body.serviceId).toBe("srv-worker");

    const urls = fetchImpl.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls.some((u) => u.pathname === "/v1/services/srv-worker/instances")).toBe(true);
    expect(urls.some((u) => u.searchParams.get("resource") === "srv-worker")).toBe(true);
  });

  it("rejects ?serviceId= for a service that's not a sibling", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/services/srv-abc123" && !url.search) {
        return jsonResponse({ id: "srv-abc123", name: "web", environmentId: "env-1" });
      }
      if (url.pathname === "/v1/services") {
        return jsonResponse([
          { service: { id: "srv-abc123", name: "web", environmentId: "env-1" }, cursor: "a" },
        ]);
      }
      return jsonResponse({ data: [] });
    });
    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/vitals?serviceId=srv-other");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("service_not_in_harness");
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
    __resetVitalsSiblingCache();
  });
  afterEach(() => {
    delete process.env.RENDER_API_KEY;
    delete process.env.RENDER_OWNER_ID;
  });

  it("proxies logs from the Render API and unpacks the `labels` array", async () => {
    // Render's /v1/logs response keeps level/type/method/path/statusCode
    // inside labels rather than at the top level; verify we surface
    // them through to the operator UI.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        logs: [
          {
            id: "log-1",
            timestamp: "2026-05-17T10:00:00.000Z",
            message: "GET /healthz 200",
            labels: [
              { name: "level", value: "info" },
              { name: "type", value: "request" },
              { name: "method", value: "GET" },
              { name: "path", value: "/healthz" },
              { name: "statusCode", value: "200" },
              { name: "instance", value: "srv-abc123-7gx2" },
              { name: "resource", value: "srv-abc123" },
            ],
          },
        ],
        nextCursor: "next",
      }),
    );
    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/vitals/logs?level=info&text=hello&limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: Array<{
        id: string;
        level: string | null;
        type: string | null;
        method: string | null;
        path: string | null;
        statusCode: string | null;
        instance: string | null;
        resource: string | null;
      }>;
      nextCursor: string | null;
    };
    expect(body.logs[0]).toMatchObject({
      id: "log-1",
      level: "info",
      type: "request",
      method: "GET",
      path: "/healthz",
      statusCode: "200",
      instance: "srv-abc123-7gx2",
      resource: "srv-abc123",
    });
    expect(body.nextCursor).toBe("next");

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/logs");
    expect(url.searchParams.get("ownerId")).toBe("own-123");
    expect(url.searchParams.get("resource")).toBe("srv-abc123");
    expect(url.searchParams.get("level")).toBe("info");
    expect(url.searchParams.get("text")).toBe("hello");
  });

  it("falls back to top-level fields when Render returns them flat", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        logs: [
          {
            id: "log-2",
            timestamp: "2026-05-17T10:00:00.000Z",
            message: "hello",
            level: "warn",
            type: "app",
            statusCode: 500,
          },
        ],
      }),
    );
    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/vitals/logs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: Array<{ level: string | null; type: string | null; statusCode: string | null }>;
    };
    expect(body.logs[0]).toMatchObject({ level: "warn", type: "app", statusCode: "500" });
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

describe("GET /vitals/services", () => {
  beforeEach(() => {
    process.env.RENDER_API_KEY = "rnd_test";
    __resetVitalsSiblingCache();
  });
  afterEach(() => {
    delete process.env.RENDER_API_KEY;
  });

  it("lists sibling services scoped to the current environment", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/services/srv-abc123" && !url.search) {
        return jsonResponse({
          id: "srv-abc123",
          name: "web",
          type: "web_service",
          environmentId: "env-1",
          dashboardUrl: "https://dashboard.render.com/web/srv-abc123",
        });
      }
      if (url.pathname === "/v1/services") {
        expect(url.searchParams.get("environmentId")).toBe("env-1");
        return jsonResponse([
          {
            service: {
              id: "srv-abc123",
              name: "web",
              type: "web_service",
              environmentId: "env-1",
              suspended: "not_suspended",
            },
            cursor: "a",
          },
          {
            service: {
              id: "srv-worker",
              name: "worker",
              type: "background_worker",
              environmentId: "env-1",
              suspended: "not_suspended",
            },
            cursor: "b",
          },
          {
            service: {
              id: "srv-cron",
              name: "nightly",
              type: "cron_job",
              environmentId: "env-1",
              suspended: "not_suspended",
            },
            cursor: "c",
          },
        ]);
      }
      throw new Error(`unexpected url ${url.pathname}`);
    });

    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/vitals/services");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: Array<{ serviceId: string; isCurrent: boolean; type: string | null }>;
      currentServiceId: string;
    };
    expect(body.currentServiceId).toBe("srv-abc123");
    expect(body.services.map((s) => s.serviceId)).toEqual(["srv-abc123", "srv-worker", "srv-cron"]);
    expect(body.services[0]).toMatchObject({ isCurrent: true, type: "web_service" });
    expect(body.services[1]).toMatchObject({ isCurrent: false, type: "background_worker" });
  });

  it("falls back to a singleton list when the current service has no environment", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/services/srv-abc123" && !url.search) {
        return jsonResponse({ id: "srv-abc123", name: "lonely web", type: "web_service" });
      }
      throw new Error(`unexpected url ${url.pathname}`);
    });
    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/vitals/services");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: Array<{ serviceId: string; isCurrent: boolean }>;
    };
    expect(body.services).toHaveLength(1);
    expect(body.services[0]).toMatchObject({ serviceId: "srv-abc123", isCurrent: true });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
