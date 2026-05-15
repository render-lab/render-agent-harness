import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  DeploymentAgentInfo,
  DeploymentAgentRuntime,
  DeploymentEnvVar,
  DeploymentInfo,
} from "@render-harness/contracts";
import type { LoadedPack } from "./load-pack.js";
import type { AgentEntryInput, EnvVarSpec, HarnessConfig, RuntimeBlockInput } from "./schema.js";
import { isWorkflowTaskAgent } from "./schema.js";

/**
 * Translate a loaded {@link HarnessConfig} into the wire-shape consumed
 * by the operator UI (`GET /deployment`). The bundle entrypoints feed
 * this to `serveWeb({ deployment })` so the UI header and Guide template
 * against the actual running stack instead of "operator-demo"
 * placeholders.
 *
 * `agent.name` is the canonical agent name in `agent_runs` rows (set by
 * `defineFromConfig` from the manifest `id`); we surface both here so
 * the UI can cross-reference runs by either field.
 */
export function toDeploymentInfo(config: HarnessConfig): DeploymentInfo {
  const info: DeploymentInfo = {
    name: config.name,
    description: config.description,
    agents: config.agents.map(toAgentInfo),
  };
  const caps = config.capabilities?.map((c) => c.pack);
  if (caps && caps.length > 0) info.capabilityPacks = caps;
  return info;
}

function toAgentInfo(entry: AgentEntryInput): DeploymentAgentInfo {
  return {
    id: entry.id,
    name: entry.id,
    runtimes: entry.runtimes.map(toRuntime),
    workflowTask: isWorkflowTaskAgent(entry),
  };
}

/**
 * Enrich a {@link DeploymentInfo} with the in-UI edit hooks: the
 * wizard service URL (from `RENDER_HARNESS_WIZARD_URL`) and the repo
 * locator from `.render-harness/agent.json` in the deployed bundle.
 *
 * Both fields are optional — if either is missing, the operator UI
 * hides the corresponding edit affordances rather than failing. Read
 * is best-effort; a malformed agent.json returns the base info
 * unchanged.
 *
 * `configPath` is the `render-harness.yaml` path (same one
 * `defineFromConfig` accepts). The metadata file is searched for
 * alongside that yaml: `<dirname(configPath)>/.render-harness/agent.json`.
 */
export interface EnrichDeploymentInfoOpts {
  /**
   * The parsed harness config. When provided, `envSchema` is merged
   * with capability-pack contributions and annotated with `isSet`.
   */
  config?: HarnessConfig;
  /**
   * Loaded capability packs (from `defineFromConfig`). Each pack's
   * `envSchema` is folded into the deployment's surface so the Config
   * tab lists every var the running stack needs.
   */
  packs?: LoadedPack[];
  /** Env source for `isSet` and Render-service lookups. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export async function enrichDeploymentInfo(
  base: DeploymentInfo,
  configPath: string,
  opts: EnrichDeploymentInfoOpts = {},
): Promise<DeploymentInfo> {
  const env = opts.env ?? process.env;
  const out: DeploymentInfo = { ...base };

  const wizardUrl = env.RENDER_HARNESS_WIZARD_URL;
  if (wizardUrl && wizardUrl.length > 0) out.wizardServiceUrl = wizardUrl;

  const metadataPath = resolve(dirname(configPath), ".render-harness", "agent.json");
  try {
    const raw = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const m = parsed as {
        org?: unknown;
        repo?: unknown;
        installationId?: unknown;
      };
      out.repoLocator = {
        org: typeof m.org === "string" ? m.org : null,
        repo: typeof m.repo === "string" ? m.repo : null,
        installationId: typeof m.installationId === "string" ? m.installationId : null,
      };
    }
  } catch {
    // Missing or malformed: leave repoLocator undefined.
  }

  if (opts.config) {
    out.envSchema = mergeEnvSchema(opts.config, opts.packs ?? [], env);
  }

  // Render auto-injects RENDER_SERVICE_ID on every deployed service.
  // RENDER_API_KEY is set manually by the operator (or the harness
  // installer) and is what gates in-UI env-var writes.
  const serviceId = env.RENDER_SERVICE_ID ?? null;
  const apiKeyConfigured = Boolean(env.RENDER_API_KEY && env.RENDER_API_KEY.length > 0);
  if (serviceId || apiKeyConfigured) {
    out.renderService = { serviceId, apiKeyConfigured };
  }

  return out;
}

/**
 * Merge env-var requirements from four sources, in order of precedence
 * (later wins):
 *
 *   1. Implicit harness-operational vars (DATABASE_URL, KV_URL, etc.)
 *   2. Model API keys derived from `shared.model.apiKeyEnv` + each
 *      agent's `model.apiKeyEnv` — these aren't in any envSchema today
 *      but are obviously required.
 *   3. Manifest-declared `config.envSchema` entries.
 *   4. Capability-pack `envSchema` entries (matches the deploy emitter).
 *
 * Each entry is annotated with `isSet` from the running env so the
 * Config tab can show status pills.
 */
function mergeEnvSchema(
  config: HarnessConfig,
  packs: LoadedPack[],
  env: NodeJS.ProcessEnv,
): DeploymentEnvVar[] {
  const ordered = new Map<string, DeploymentEnvVar>();

  // 1. Implicit harness operational vars. These are needed by the web
  // service / runtime layer itself; not declared in render-harness.yaml
  // but very real. We include them so operators have one place to see
  // and rotate them.
  for (const spec of implicitOperationalVars(config)) {
    ordered.set(spec.name, annotate(spec, env, { source: "harness" }));
  }

  // 2. Model API keys (one per unique `apiKeyEnv` across models).
  for (const apiKeyEnv of collectModelApiKeyEnvs(config)) {
    if (ordered.has(apiKeyEnv)) continue;
    ordered.set(
      apiKeyEnv,
      annotate(
        {
          name: apiKeyEnv,
          required: true,
          secret: true,
          description: "Model provider API key (referenced by render-harness.yaml model spec).",
        },
        env,
        { source: "harness" },
      ),
    );
  }

  // 3. Manifest-declared envSchema (overrides implicit defaults).
  for (const spec of config.envSchema ?? []) {
    ordered.set(spec.name, annotate(spec, env, { source: "harness" }));
  }

  // 4. Capability-pack contributions (wins on conflict, same as deploy emitter).
  for (const loaded of packs) {
    for (const spec of loaded.pack.envSchema ?? []) {
      ordered.set(
        spec.name,
        annotate(spec, env, { source: "capability", packName: loaded.pack.name }),
      );
    }
  }

  return [...ordered.values()];
}

function collectModelApiKeyEnvs(config: HarnessConfig): string[] {
  const seen = new Set<string>();
  const collect = (apiKeyEnv: string | undefined, provider: string | undefined) => {
    // Default per provider when apiKeyEnv is unset.
    const key =
      apiKeyEnv ?? (provider === "openai-compat" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
    if (key) seen.add(key);
  };
  if (config.shared?.model) {
    collect(config.shared.model.apiKeyEnv, config.shared.model.provider);
  }
  for (const agent of config.agents) {
    if (agent.model) collect(agent.model.apiKeyEnv, agent.model.provider);
  }
  return [...seen];
}

/**
 * Operational env vars the harness web service / runtime layer
 * depends on. Surfaced in the Config tab so operators can see and
 * rotate them without going to the dashboard.
 */
function implicitOperationalVars(config: HarnessConfig): EnvVarSpec[] {
  const out: EnvVarSpec[] = [
    {
      name: "DATABASE_URL",
      required: true,
      secret: true,
      description: "Postgres connection string. Required by every runtime that persists state.",
    },
    {
      name: "KV_URL",
      required: true,
      secret: true,
      description: "Valkey/Redis-compatible URL. Used for cancel flags and SSE pointers.",
    },
  ];
  const ui = config.shared?.ui === true;
  if (ui) {
    out.push(
      {
        name: "WEB_API_KEY",
        required: true,
        secret: true,
        description: "Bearer token the operator UI's /ui/login form validates against.",
      },
      {
        name: "UI_COOKIE_SECRET",
        required: true,
        secret: true,
        description: "HMAC secret used to sign the operator UI session cookie.",
      },
    );
  }
  out.push(
    {
      name: "RENDER_API_KEY",
      required: false,
      secret: true,
      description:
        "Workspace-scoped Render API key. Required to let the Config tab write env vars back via the Render API.",
    },
    {
      name: "RENDER_HARNESS_WIZARD_URL",
      required: false,
      secret: false,
      description:
        "Origin of the wizard service. Required for the Agents tab's in-UI model edit button.",
    },
    {
      name: "WIZARD_SHARED_SECRET",
      required: false,
      secret: true,
      description:
        "Shared secret for server-to-server PATCH calls into the wizard. Must match the wizard's value.",
    },
  );
  return out;
}

function annotate(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv,
  extras: { source: "harness" | "capability"; packName?: string },
): DeploymentEnvVar {
  const value = env[spec.name];
  const out: DeploymentEnvVar = {
    name: spec.name,
    required: spec.required,
    secret: spec.secret,
    isSet: typeof value === "string" && value.length > 0,
    source: extras.source,
  };
  if (spec.description) out.description = spec.description;
  if (spec.default !== undefined) out.default = spec.default;
  if (extras.packName) out.packName = extras.packName;
  return out;
}

function toRuntime(rt: RuntimeBlockInput): DeploymentAgentRuntime {
  switch (rt.kind) {
    case "web":
      return { kind: "web" };
    case "worker":
      return rt.queue ? { kind: "worker", queue: rt.queue } : { kind: "worker" };
    case "cron":
      return {
        kind: "cron",
        schedule: rt.schedule,
        via: rt.via ?? "cron",
      };
    case "workflows":
      return { kind: "workflows" };
  }
}
