import type {
  DeploymentInfo,
  VitalsInstance,
  VitalsLogEntry,
  VitalsLogsResp,
  VitalsMetricKind,
  VitalsMetricPoint,
  VitalsMetricSeries,
  VitalsResp,
  VitalsServiceSummary,
  VitalsServicesResp,
} from "@render-harness/contracts";
import type { UserId } from "@render-harness/core";
import type { Hono } from "hono";

export interface VitalsRouteContext {
  auth: (req: Request) => Promise<UserId | null>;
  deployment?: DeploymentInfo;
  pathPrefix: string;
  /** Override the Render API base URL. Tests pass a stub origin. */
  renderApiBase?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_RENDER_API_BASE = "https://api.render.com";
const DEFAULT_RANGE_MINUTES = 60;
const DEFAULT_RESOLUTION_SECONDS = 60;
const MAX_RANGE_MINUTES = 24 * 60;
const MAX_LOG_LIMIT = 100;
const MAX_SIBLING_SERVICES = 50;

/**
 * Sibling service lookups go through the Render API on every Vitals
 * panel load. We cache the resolved list per (apiKey, currentServiceId)
 * pair for a short window so flipping between services on the UI
 * doesn't pay the env-discovery round-trip every time.
 */
interface SiblingCacheEntry {
  expiresAt: number;
  services: VitalsServiceSummary[];
  currentEnvironmentId: string | null;
}
const SIBLING_CACHE = new Map<string, SiblingCacheEntry>();
const SIBLING_CACHE_TTL_MS = 60_000;

/** Test helper: drop the sibling-service cache so the next /vitals call re-fetches. */
export function __resetVitalsSiblingCache(): void {
  SIBLING_CACHE.clear();
}

export function registerVitalsRoutes(app: Hono, ctx: VitalsRouteContext): void {
  const { auth, deployment, pathPrefix } = ctx;
  const r = (path: string) => `${pathPrefix}${path}`;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const apiBase = ctx.renderApiBase ?? DEFAULT_RENDER_API_BASE;

  app.get(r("/vitals/services"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    if (!deployment?.operatorFeatures?.vitals.enabled) {
      return c.json(
        {
          error: "vitals_disabled",
          details: "set RENDER_HARNESS_VITALS_ENABLED=1 to enable the Vitals tab",
        },
        404,
      );
    }

    const config = renderConfig(deployment);
    if ("error" in config) return c.json(config.body, 503);

    const render = new RenderVitalsClient({
      apiBase,
      apiKey: config.apiKey,
      fetchImpl,
    });

    try {
      const siblings = await resolveSiblingServices(render, config);
      const body: VitalsServicesResp = {
        services: siblings,
        currentServiceId: config.serviceId,
      };
      return c.json(body);
    } catch (err) {
      return c.json(renderApiErrorBody(err), 502);
    }
  });

  app.get(r("/vitals"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    if (!deployment?.operatorFeatures?.vitals.enabled) {
      return c.json(
        {
          error: "vitals_disabled",
          details: "set RENDER_HARNESS_VITALS_ENABLED=1 to enable the Vitals tab",
        },
        404,
      );
    }

    const config = renderConfig(deployment);
    if ("error" in config) return c.json(config.body, 503);

    const url = new URL(c.req.url);
    const rangeMinutes = clampNumber(
      Number(url.searchParams.get("rangeMinutes") ?? DEFAULT_RANGE_MINUTES),
      5,
      MAX_RANGE_MINUTES,
      DEFAULT_RANGE_MINUTES,
    );
    const resolutionSeconds = clampNumber(
      Number(url.searchParams.get("resolutionSeconds") ?? DEFAULT_RESOLUTION_SECONDS),
      30,
      3600,
      DEFAULT_RESOLUTION_SECONDS,
    );
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - rangeMinutes * 60_000);

    const render = new RenderVitalsClient({
      apiBase,
      apiKey: config.apiKey,
      fetchImpl,
    });

    const requestedServiceId = url.searchParams.get("serviceId");
    let targetServiceId: string;
    try {
      targetServiceId = await resolveTargetServiceId(render, config, requestedServiceId);
    } catch (err) {
      if (err instanceof InvalidServiceError) {
        return c.json({ error: err.code, details: err.message }, 400);
      }
      return c.json(renderApiErrorBody(err), 502);
    }

    try {
      const [instances, cpu, memory, latency] = await Promise.all([
        render.listInstances(targetServiceId),
        render.metric("cpu", {
          startTime,
          endTime,
          resolutionSeconds,
          resourceId: targetServiceId,
        }),
        render.metric("memory", {
          startTime,
          endTime,
          resolutionSeconds,
          resourceId: targetServiceId,
        }),
        render.metric("httpLatencyP95", {
          startTime,
          endTime,
          resolutionSeconds,
          resourceId: targetServiceId,
        }),
      ]);

      const body: VitalsResp = {
        serviceId: targetServiceId,
        range: {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          resolutionSeconds,
        },
        instances,
        metrics: [cpu, memory, latency],
      };
      return c.json(body);
    } catch (err) {
      return c.json(renderApiErrorBody(err), 502);
    }
  });

  app.get(r("/vitals/logs"), async (c) => {
    const userId = await auth(c.req.raw);
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    if (!deployment?.operatorFeatures?.vitals.enabled) {
      return c.json(
        {
          error: "vitals_disabled",
          details: "set RENDER_HARNESS_VITALS_ENABLED=1 to enable the Vitals tab",
        },
        404,
      );
    }

    const config = renderConfig(deployment);
    if ("error" in config) return c.json(config.body, 503);

    const ownerId = process.env.RENDER_OWNER_ID;
    if (!ownerId) {
      return c.json(
        {
          error: "render_owner_not_configured",
          details: "set RENDER_OWNER_ID on this service to enable Render log queries",
        },
        503,
      );
    }

    const url = new URL(c.req.url);
    const limit = clampNumber(Number(url.searchParams.get("limit") ?? 50), 1, MAX_LOG_LIMIT, 50);
    const render = new RenderVitalsClient({
      apiBase,
      apiKey: config.apiKey,
      fetchImpl,
    });

    const requestedServiceId = url.searchParams.get("serviceId");
    let targetServiceId: string;
    try {
      targetServiceId = await resolveTargetServiceId(render, config, requestedServiceId);
    } catch (err) {
      if (err instanceof InvalidServiceError) {
        return c.json({ error: err.code, details: err.message }, 400);
      }
      return c.json(renderApiErrorBody(err), 502);
    }

    try {
      const body = await render.logs({
        ownerId,
        resourceId: targetServiceId,
        limit,
        level: url.searchParams.getAll("level"),
        type: url.searchParams.getAll("type"),
        text: url.searchParams.getAll("text"),
      });
      return c.json(body);
    } catch (err) {
      return c.json(renderApiErrorBody(err), 502);
    }
  });
}

/**
 * Confirm a caller-supplied `?serviceId=` is actually a sibling of the
 * service the harness is running on. Without this any authenticated
 * operator could pull metrics + logs for any service the workspace API
 * key can see; the Vitals tab is intentionally scoped to the harness
 * deployment.
 *
 * When the requested id is missing or matches the current service we
 * short-circuit — no Render API call needed.
 */
async function resolveTargetServiceId(
  render: RenderVitalsClient,
  config: RenderConfig,
  requested: string | null,
): Promise<string> {
  if (!requested || requested === config.serviceId) return config.serviceId;
  const siblings = await resolveSiblingServices(render, config);
  const match = siblings.find((s) => s.serviceId === requested);
  if (!match) {
    throw new InvalidServiceError(
      "service_not_in_harness",
      `Service ${requested} is not part of this harness deployment.`,
    );
  }
  return match.serviceId;
}

/**
 * Resolve the list of services that belong to this harness. "Belongs"
 * means: lives in the same Render environment as the current service
 * (the one Render auto-injected `RENDER_SERVICE_ID` for).
 *
 * The harness's blueprint usually creates a web service, a worker
 * service, one or more cron jobs, and sometimes a wizard service — all
 * in the same environment. Listing by environment is the only signal
 * Render exposes that scopes precisely to "this deployment".
 *
 * If the current service has no environment (legacy services pre-dating
 * environments), we fall back to a singleton list with just the
 * current service so the UI still works.
 */
async function resolveSiblingServices(
  render: RenderVitalsClient,
  config: RenderConfig,
): Promise<VitalsServiceSummary[]> {
  const cacheKey = `${config.apiKey}:${config.serviceId}`;
  const cached = SIBLING_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.services;

  const current = await render.getService(config.serviceId);
  const currentEnvironmentId = current?.environmentId ?? null;

  let raw: RawService[] = [];
  if (currentEnvironmentId) {
    raw = await render.listServicesInEnvironment(currentEnvironmentId);
  }

  let services = raw
    .map((s) => normalizeService(s, config.serviceId))
    .filter((s): s is VitalsServiceSummary => s !== null);

  // If the env-scoped query returned nothing useful (no env id, or
  // Render returned no rows), fall back to a singleton list so the UI
  // can still render the current service.
  if (services.length === 0 && current) {
    const fallback = normalizeService(current, config.serviceId);
    if (fallback) services = [fallback];
  }

  services.sort(compareServices);
  if (services.length > MAX_SIBLING_SERVICES) {
    services = services.slice(0, MAX_SIBLING_SERVICES);
  }

  SIBLING_CACHE.set(cacheKey, {
    services,
    currentEnvironmentId,
    expiresAt: Date.now() + SIBLING_CACHE_TTL_MS,
  });
  return services;
}

class InvalidServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function compareServices(a: VitalsServiceSummary, b: VitalsServiceSummary): number {
  if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
  const typeOrder = serviceTypeOrder(a.type) - serviceTypeOrder(b.type);
  if (typeOrder !== 0) return typeOrder;
  return a.name.localeCompare(b.name);
}

function serviceTypeOrder(type: string | null): number {
  switch (type) {
    case "web_service":
      return 0;
    case "private_service":
      return 1;
    case "background_worker":
      return 2;
    case "cron_job":
      return 3;
    case "static_site":
      return 4;
    default:
      return 5;
  }
}

interface RenderConfig {
  serviceId: string;
  apiKey: string;
}

function renderConfig(deployment: DeploymentInfo | undefined):
  | RenderConfig
  | {
      error: true;
      body: { error: string; details: string };
    } {
  const serviceId = deployment?.renderService?.serviceId;
  if (!serviceId) {
    return {
      error: true,
      body: {
        error: "render_service_not_configured",
        details: "RENDER_SERVICE_ID is unset; vitals need a Render service id",
      },
    };
  }
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) {
    return {
      error: true,
      body: {
        error: "render_api_key_not_configured",
        details: "set RENDER_API_KEY on this service to enable Render vitals",
      },
    };
  }
  return { serviceId, apiKey };
}

interface RenderVitalsClientOpts {
  apiBase: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}

interface MetricQuery {
  startTime: Date;
  endTime: Date;
  resolutionSeconds: number;
  resourceId: string;
}

interface LogsQuery {
  ownerId: string;
  resourceId: string;
  limit: number;
  level: string[];
  type: string[];
  text: string[];
}

class RenderVitalsClient {
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RenderVitalsClientOpts) {
    this.apiBase = trimTrailingSlash(opts.apiBase);
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl;
  }

  async listInstances(serviceId: string): Promise<VitalsInstance[]> {
    const raw = await this.fetchJson<unknown>(
      `/v1/services/${encodeURIComponent(serviceId)}/instances`,
      {},
    );
    return asArray(raw)
      .map(normalizeInstance)
      .filter((i): i is VitalsInstance => i !== null);
  }

  async getService(serviceId: string): Promise<RawService | null> {
    const raw = await this.fetchJson<unknown>(`/v1/services/${encodeURIComponent(serviceId)}`, {});
    return extractRawService(raw);
  }

  /**
   * List every service in a Render environment. The /v1/services
   * response is a `[{ service, cursor }, ...]` array; we unwrap into
   * raw `service` records here so the normalizer doesn't need to
   * know about the envelope. We cap the page at 100 (the Render API
   * max) — harness deployments are not expected to exceed that.
   */
  async listServicesInEnvironment(environmentId: string): Promise<RawService[]> {
    const raw = await this.fetchJson<unknown>("/v1/services", {
      environmentId,
      limit: "100",
    });
    const items = asArray(raw);
    const out: RawService[] = [];
    for (const item of items) {
      const svc = extractRawService(item);
      if (svc) out.push(svc);
    }
    return out;
  }

  async metric(kind: VitalsMetricKind, query: MetricQuery): Promise<VitalsMetricSeries> {
    const raw = await this.fetchJson<unknown>(metricPath(kind), {
      startTime: query.startTime.toISOString(),
      endTime: query.endTime.toISOString(),
      resolutionSeconds: String(query.resolutionSeconds),
      resource: query.resourceId,
      ...(kind === "cpu" ? { aggregationMethod: "AVG" } : {}),
      ...(kind === "httpLatencyP95" ? { quantile: "0.95" } : {}),
    });
    return {
      kind,
      label: metricLabel(kind),
      unit: metricUnit(kind),
      points: extractMetricPoints(raw),
    };
  }

  async logs(query: LogsQuery): Promise<VitalsLogsResp> {
    const raw = await this.fetchJson<unknown>("/v1/logs", {
      ownerId: query.ownerId,
      resource: query.resourceId,
      direction: "backward",
      limit: String(query.limit),
      ...arrayParams("level", query.level),
      ...arrayParams("type", query.type),
      ...arrayParams("text", query.text),
    });
    return {
      logs: asArray(raw)
        .map(normalizeLog)
        .filter((l): l is VitalsLogEntry => l !== null),
      nextCursor: readStringField(raw, ["nextCursor", "cursor"]),
    };
  }

  private async fetchJson<T>(path: string, params: Record<string, string | string[]>): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(params)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (item) url.searchParams.append(key, item);
      }
    }
    const res = await this.fetchImpl(url.toString(), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new RenderVitalsApiError({
        path,
        status: res.status,
        body: text,
      });
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

class RenderVitalsApiError extends Error {
  readonly path: string;
  readonly status: number;
  readonly responseBody: string;

  constructor(opts: { path: string; status: number; body: string }) {
    super(`Render API GET ${opts.path} failed: ${opts.status} ${opts.body.slice(0, 500)}`);
    this.path = opts.path;
    this.status = opts.status;
    this.responseBody = opts.body;
  }
}

function metricPath(kind: VitalsMetricKind): string {
  switch (kind) {
    case "cpu":
      return "/v1/metrics/cpu";
    case "memory":
      return "/v1/metrics/memory";
    case "httpLatencyP95":
      return "/v1/metrics/http-latency";
  }
}

function metricLabel(kind: VitalsMetricKind): string {
  switch (kind) {
    case "cpu":
      return "CPU";
    case "memory":
      return "Memory";
    case "httpLatencyP95":
      return "HTTP p95 latency";
  }
}

function metricUnit(kind: VitalsMetricKind): VitalsMetricSeries["unit"] {
  switch (kind) {
    case "cpu":
      return "percent";
    case "memory":
      return "bytes";
    case "httpLatencyP95":
      return "milliseconds";
  }
}

interface RawService {
  id: string;
  name?: string;
  type?: string;
  suspended?: string;
  dashboardUrl?: string;
  environmentId?: string;
}

function extractRawService(raw: unknown): RawService | null {
  if (!isRecord(raw)) return null;
  // /v1/services items come wrapped as `{ service, cursor }`; the single
  // /v1/services/:id endpoint returns the bare service object. Handle both.
  const candidate = isRecord(raw.service) ? raw.service : raw;
  if (!isRecord(candidate)) return null;
  const id = readStringField(candidate, ["id"]);
  if (!id) return null;
  const out: RawService = { id };
  const name = readStringField(candidate, ["name"]);
  if (name) out.name = name;
  const type = readStringField(candidate, ["type"]);
  if (type) out.type = type;
  const suspended = readStringField(candidate, ["suspended"]);
  if (suspended) out.suspended = suspended;
  const dashboardUrl = readStringField(candidate, ["dashboardUrl", "dashboard_url"]);
  if (dashboardUrl) out.dashboardUrl = dashboardUrl;
  const environmentId = readStringField(candidate, ["environmentId", "environment_id"]);
  if (environmentId) out.environmentId = environmentId;
  return out;
}

function normalizeService(raw: RawService, currentServiceId: string): VitalsServiceSummary | null {
  return {
    serviceId: raw.id,
    name: raw.name ?? raw.id,
    type: raw.type ?? null,
    suspended: raw.suspended ?? null,
    dashboardUrl: raw.dashboardUrl ?? null,
    environmentId: raw.environmentId ?? null,
    isCurrent: raw.id === currentServiceId,
  };
}

function normalizeInstance(raw: unknown): VitalsInstance | null {
  const value = unwrapResource(raw, "instance");
  if (!isRecord(value)) return null;
  const id = readStringField(value, ["id", "instanceId"]);
  if (!id) return null;
  return {
    id,
    name: readStringField(value, ["name"]),
    status: readStringField(value, ["status", "state"]),
    createdAt: readStringField(value, ["createdAt", "created_at"]),
    updatedAt: readStringField(value, ["updatedAt", "updated_at"]),
  };
}

function normalizeLog(raw: unknown): VitalsLogEntry | null {
  const value = unwrapResource(raw, "log");
  if (!isRecord(value)) return null;
  const timestamp = readStringField(value, ["timestamp", "time", "createdAt", "created_at"]);
  const message = readStringField(value, ["message", "text", "line"]);
  if (!timestamp || !message) return null;
  return {
    id: readStringField(value, ["id"]) ?? `${timestamp}:${message.slice(0, 80)}`,
    timestamp,
    message,
    level: readStringField(value, ["level", "severity"]),
    type: readStringField(value, ["type"]),
    resource: readStringField(value, ["resource", "resourceId"]),
    instance: readStringField(value, ["instance", "instanceId"]),
    method: readStringField(value, ["method"]),
    path: readStringField(value, ["path"]),
    statusCode: readStatusCode(value),
  };
}

function extractMetricPoints(raw: unknown): VitalsMetricPoint[] {
  const points: VitalsMetricPoint[] = [];
  collectMetricPoints(raw, points);
  return points.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function collectMetricPoints(raw: unknown, points: VitalsMetricPoint[]): void {
  if (Array.isArray(raw)) {
    for (const item of raw) collectMetricPoints(item, points);
    return;
  }
  if (!isRecord(raw)) return;

  const timestamp = readStringField(raw, ["timestamp", "time", "startTime", "start_time"]);
  const value = readNumberField(raw, ["value", "usage", "cpu", "memory", "latency"]);
  if (timestamp && value !== null) {
    points.push({ timestamp, value });
  }

  for (const key of ["data", "metrics", "series", "values", "points", "samples"]) {
    const nested = raw[key];
    if (nested !== undefined) collectMetricPoints(nested, points);
  }
}

function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  for (const key of ["items", "data", "logs", "instances", "results"]) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function unwrapResource(raw: unknown, key: string): unknown {
  if (!isRecord(raw)) return raw;
  return raw[key] ?? raw;
}

function readStringField(raw: unknown, keys: string[]): string | null {
  if (!isRecord(raw)) return null;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readNumberField(raw: unknown, keys: string[]): number | null {
  if (!isRecord(raw)) return null;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readStatusCode(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const status = raw.statusCode ?? raw.status_code;
  if (typeof status === "number" && Number.isFinite(status)) return String(status);
  if (typeof status === "string" && status.length > 0) return status;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function arrayParams(key: string, values: string[]): Record<string, string[]> {
  const filtered = values.filter((value) => value.length > 0);
  return filtered.length > 0 ? { [key]: filtered } : {};
}

function renderApiErrorBody(err: unknown): {
  error: "render_api_error";
  status?: number;
  details: string;
} {
  if (err instanceof RenderVitalsApiError) {
    return {
      error: "render_api_error",
      status: err.status,
      details: err.responseBody.slice(0, 1000),
    };
  }
  return {
    error: "render_api_error",
    details: err instanceof Error ? err.message : String(err),
  };
}

function clampNumber(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
