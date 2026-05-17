import type { Logger } from "@render-harness/core";
import type { ConnectorWebCtx } from "@render-harness/registry";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerConnectorRoutes } from "./connectors.js";

const logger = {
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const auth = async () => "test-user";

describe("registerConnectorRoutes", () => {
  it("returns 404 for unknown connectors", async () => {
    const app = new Hono();
    registerConnectorRoutes(app, { connectors: new Map(), auth, logger, pathPrefix: "" });
    const res = await app.fetch(new Request("http://x/connectors/missing", { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("delegates POST requests to the mounted connector", async () => {
    const app = new Hono();
    const connectors = new Map([
      [
        "test",
        {
          key: "test",
          packName: "@acme/cap-test",
          contribution: {
            webhook: async (req: Request) =>
              Response.json({ body: await req.text(), method: req.method }, { status: 202 }),
          },
          ctx: {} as ConnectorWebCtx,
        },
      ],
    ]);
    registerConnectorRoutes(app, { connectors, auth, logger, pathPrefix: "" });
    const res = await app.fetch(
      new Request("http://x/connectors/test", { method: "POST", body: "payload" }),
    );
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ body: "payload", method: "POST" });
  });

  it("lists mounted connectors with auth", async () => {
    const app = new Hono();
    const connectors = new Map([
      [
        "test",
        {
          key: "test",
          packName: "@acme/cap-test",
          contribution: { webhook: async () => Response.json({ ok: true }) },
          ctx: {} as ConnectorWebCtx,
        },
      ],
    ]);
    registerConnectorRoutes(app, { connectors, auth, logger, pathPrefix: "/api" });
    const res = await app.fetch(new Request("http://x/api/connectors"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      connectors: [{ key: "test", pack: "@acme/cap-test", url: "/api/connectors/test" }],
    });
  });
});
