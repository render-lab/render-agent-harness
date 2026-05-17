import type { Logger } from "@render-harness/core";
import type { ConnectorContribution, ConnectorWebCtx } from "@render-harness/registry";
import type { Hono } from "hono";

export interface MountedConnector {
  contribution: ConnectorContribution;
  ctx: ConnectorWebCtx;
}

export interface ConnectorRouteContext {
  connectors: Map<string, MountedConnector>;
  logger: Logger;
  pathPrefix: string;
}

export function registerConnectorRoutes(app: Hono, ctx: ConnectorRouteContext): void {
  const r = (path: string) => `${ctx.pathPrefix}${path}`;
  const handle = async (req: Request, key: string) => {
    const mounted = ctx.connectors.get(key);
    if (!mounted) {
      return Response.json(
        { error: "unknown_connector", message: `no connector named "${key}"` },
        { status: 404 },
      );
    }
    const started = Date.now();
    const warnTimer = setTimeout(() => {
      ctx.logger.warn(
        { key, elapsedMs: Date.now() - started },
        "connector webhook is still running",
      );
    }, 3_000);
    try {
      return await mounted.contribution.webhook(req, mounted.ctx);
    } catch (err) {
      ctx.logger.error(
        { key, err: err instanceof Error ? err.message : String(err) },
        "connector webhook failed",
      );
      return Response.json({ error: "connector_failed" }, { status: 500 });
    } finally {
      clearTimeout(warnTimer);
    }
  };

  app.get(r("/connectors/:key"), async (c) => {
    const key = c.req.param("key");
    if (!key) return c.json({ error: "missing_connector" }, 400);
    return handle(c.req.raw, key);
  });
  app.post(r("/connectors/:key"), async (c) => {
    const key = c.req.param("key");
    if (!key) return c.json({ error: "missing_connector" }, 400);
    return handle(c.req.raw, key);
  });
}
