import type { ConnectorSummary, ConnectorsResp } from "@render-harness/contracts";
import type { Logger, UserId } from "@render-harness/core";
import type { ConnectorContribution, ConnectorWebCtx } from "@render-harness/registry";
import type { Hono } from "hono";

export interface MountedConnector {
  key: string;
  packName: string;
  contribution: ConnectorContribution;
  ctx: ConnectorWebCtx;
}

export interface ConnectorRouteContext {
  connectors: Map<string, MountedConnector>;
  auth: (req: Request) => Promise<UserId | null>;
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

  app.get(r("/connectors"), async (c) => {
    const userId = await ctx.auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const connectors: ConnectorSummary[] = Array.from(ctx.connectors.values()).map((mounted) => ({
      key: mounted.key,
      pack: mounted.packName,
      url: `${ctx.pathPrefix}/connectors/${mounted.key}`,
    }));
    return c.json({ connectors } satisfies ConnectorsResp);
  });

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
