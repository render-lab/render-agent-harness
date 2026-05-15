import type { DeploymentInfo } from "@render-harness/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConfigRoutes } from "./config.js";

const DEPLOYMENT: DeploymentInfo = {
  name: "test",
  agents: [],
  envSchema: [
    {
      name: "OPENAI_API_KEY",
      required: false,
      secret: true,
      isSet: false,
      source: "harness",
    },
    {
      name: "EXA_API_KEY",
      required: false,
      secret: true,
      isSet: true,
      source: "capability",
      packName: "cap-search-exa",
    },
  ],
  renderService: { serviceId: "srv-abc123", apiKeyConfigured: true },
};

function makeApp(overrides?: {
  deployment?: DeploymentInfo | undefined;
  fetchImpl?: typeof fetch;
  authReturn?: string | null;
}) {
  const app = new Hono();
  registerConfigRoutes(app, {
    auth: async () => (overrides?.authReturn === undefined ? "u1" : overrides.authReturn),
    deployment: overrides?.deployment === undefined ? DEPLOYMENT : overrides.deployment,
    pathPrefix: "",
    renderApiBase: "https://api.render.test",
    fetchImpl: overrides?.fetchImpl ?? (vi.fn() as unknown as typeof fetch),
  });
  return app;
}

describe("GET /config/env-vars", () => {
  it("returns the schema with fresh isSet flags from process.env", async () => {
    process.env.OPENAI_API_KEY = "sk-abc";
    const app = makeApp();
    const res = await app.request("/config/env-vars");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { envVars: Array<{ name: string; isSet: boolean }> };
    const openai = body.envVars.find((v) => v.name === "OPENAI_API_KEY");
    expect(openai?.isSet).toBe(true);
  });

  it("401s without an authenticated user", async () => {
    const app = makeApp({ authReturn: null });
    const res = await app.request("/config/env-vars");
    expect(res.status).toBe(401);
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });
});

describe("PUT /config/env-vars/:name", () => {
  beforeEach(() => {
    process.env.RENDER_API_KEY = "rnd_test";
  });
  afterEach(() => {
    delete process.env.RENDER_API_KEY;
  });

  it("writes the env var to Render API and returns 202", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ key: "OPENAI_API_KEY" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/config/env-vars/OPENAI_API_KEY", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-new" }),
    });
    expect(res.status).toBe(202);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://api.render.test/v1/services/srv-abc123/env-vars/OPENAI_API_KEY");
    expect(call[1].method).toBe("PUT");
    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer rnd_test");
    const sent = JSON.parse(String(call[1].body)) as { value: string };
    expect(sent.value).toBe("sk-new");
  });

  it("rejects names not declared in envSchema", async () => {
    const app = makeApp();
    const res = await app.request("/config/env-vars/RANDO", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects invalid name format", async () => {
    const app = makeApp();
    const res = await app.request("/config/env-vars/lowercase", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("503s when RENDER_SERVICE_ID is missing", async () => {
    const app = makeApp({
      deployment: { ...DEPLOYMENT, renderService: { serviceId: null, apiKeyConfigured: true } },
    });
    const res = await app.request("/config/env-vars/OPENAI_API_KEY", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("render_service_not_configured");
  });

  it("503s when RENDER_API_KEY is missing", async () => {
    delete process.env.RENDER_API_KEY;
    const app = makeApp();
    const res = await app.request("/config/env-vars/OPENAI_API_KEY", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("render_api_key_not_configured");
  });

  it("surfaces Render API errors as 502", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const app = makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await app.request("/config/env-vars/OPENAI_API_KEY", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; status: number };
    expect(body.error).toBe("render_api_error");
    expect(body.status).toBe(403);
  });
});
