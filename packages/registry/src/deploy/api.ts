/**
 * Typed wrapper over Render's REST API. Each method handles one
 * resource type the deploy command provisions:
 *
 *   - `/v1/owners`        — list workspaces the API key has access to.
 *   - `/v1/services`      — web_service, private_service, background_worker,
 *                           cron_job (the Blueprint-y resources).
 *   - `/v1/postgres`      — Postgres datastores.
 *   - `/v1/key-value`     — Key Value (Valkey/Redis-compatible) datastores.
 *   - `/v1/workflows`     — Workflow services (separate API; no `repo`
 *                           field — code lands via workflow versions).
 *
 * Pure HTTP, no orchestration. The executor composes these calls
 * (database first to get its id, then services that reference it).
 */

const API_BASE = "https://api.render.com/v1";

export interface RenderApiOpts {
  apiKey: string;
  baseUrl?: string;
}

export class RenderApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: RenderApiOpts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? API_BASE;
  }

  async listOwners(): Promise<OwnerSummary[]> {
    const raw = await this.fetchJson<Array<{ owner: OwnerSummary }>>(
      "GET",
      "/owners?limit=100",
    );
    return raw.map((r) => r.owner);
  }

  async createService(body: CreateServiceBody): Promise<ServiceRef> {
    const res = await this.fetchJson<{ service: ServiceRef }>(
      "POST",
      "/services",
      body,
    );
    return res.service;
  }

  async createPostgres(body: CreatePostgresBody): Promise<PostgresRef> {
    return await this.fetchJson<PostgresRef>("POST", "/postgres", body);
  }

  async createKeyValue(body: CreateKeyValueBody): Promise<KeyValueRef> {
    return await this.fetchJson<KeyValueRef>("POST", "/key-value", body);
  }

  async createWorkflow(body: CreateWorkflowBody): Promise<WorkflowRef> {
    return await this.fetchJson<WorkflowRef>("POST", "/workflows", body);
  }

  /** Get a Postgres' connectionString once it's provisioned. */
  async getPostgresConnectionInfo(id: string): Promise<PostgresConnectionInfo> {
    return await this.fetchJson<PostgresConnectionInfo>(
      "GET",
      `/postgres/${id}/connection-info`,
    );
  }

  async getKeyValueConnectionInfo(id: string): Promise<KeyValueConnectionInfo> {
    return await this.fetchJson<KeyValueConnectionInfo>(
      "GET",
      `/key-value/${id}/connection-info`,
    );
  }

  private async fetchJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new RenderApiError({
        method,
        path,
        status: res.status,
        body: text,
      });
    }
    return (await res.json()) as T;
  }
}

export class RenderApiError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly responseBody: string;
  constructor(opts: { method: string; path: string; status: number; body: string }) {
    super(
      `Render API ${opts.method} ${opts.path} failed: ${opts.status} ${opts.body.slice(0, 500)}`,
    );
    this.method = opts.method;
    this.path = opts.path;
    this.status = opts.status;
    this.responseBody = opts.body;
  }
}

// ----------------------------------------------------------------------
// Request / response types — narrow to fields we actually use
// ----------------------------------------------------------------------

export interface OwnerSummary {
  id: string;
  name: string;
  email?: string;
  type?: "user" | "team";
}

export type ServiceType =
  | "web_service"
  | "private_service"
  | "background_worker"
  | "cron_job";

export interface CreateServiceEnvVar {
  key: string;
  value?: string;
  /** Mark sensitive: not synced from CI / not shown in dashboard plaintext. */
  isSensitive?: boolean;
}

export interface CreateServiceBody {
  type: ServiceType;
  name: string;
  ownerId: string;
  repo: string;
  branch?: string;
  autoDeploy?: "yes" | "no";
  envVars?: CreateServiceEnvVar[];
  rootDir?: string;
  serviceDetails: ServiceDetails;
}

/**
 * `serviceDetails` shape varies by service type. We model the fields
 * the harness emits — plan, region, build/start commands, schedule
 * (for cron_job), health-check path (for web_service).
 */
export type ServiceDetails =
  | {
      // web_service
      env: "node" | "docker" | "image";
      plan?: string;
      region?: string;
      healthCheckPath?: string;
      envSpecificDetails?: { buildCommand?: string; startCommand?: string };
    }
  | {
      // private_service (worker pserv) + background_worker
      env: "node" | "docker" | "image";
      plan?: string;
      region?: string;
      envSpecificDetails?: { buildCommand?: string; startCommand?: string };
    }
  | {
      // cron_job
      env: "node" | "docker" | "image";
      plan?: string;
      region?: string;
      schedule: string;
      envSpecificDetails?: { buildCommand?: string };
      // Cron jobs use a single "cronCommand" (the thing that runs).
      command?: string;
    };

export interface ServiceRef {
  id: string;
  name: string;
  type: ServiceType;
  serviceDetails: { url?: string };
}

export interface CreatePostgresBody {
  name: string;
  ownerId: string;
  plan: string;
  version?: string;
  region?: string;
  databaseName?: string;
  databaseUser?: string;
  enableHighAvailability?: boolean;
  ipAllowList?: Array<{ cidrBlock: string; description?: string }>;
}

export interface PostgresRef {
  id: string;
  name: string;
}

export interface PostgresConnectionInfo {
  externalConnectionString: string;
  internalConnectionString: string;
}

export interface CreateKeyValueBody {
  name: string;
  ownerId: string;
  plan: string;
  region?: string;
  maxmemoryPolicy?: string;
  ipAllowList?: Array<{ cidrBlock: string; description?: string }>;
}

export interface KeyValueRef {
  id: string;
  name: string;
}

export interface KeyValueConnectionInfo {
  externalConnectionString: string;
  internalConnectionString: string;
}

export interface CreateWorkflowBody {
  name: string;
  ownerId: string;
  buildConfig: { runCommand: string };
  region: string;
  autoDeployTrigger?: "commit" | "off" | "checksPass";
  envVars?: CreateServiceEnvVar[];
}

export interface WorkflowRef {
  id: string;
  name: string;
}
