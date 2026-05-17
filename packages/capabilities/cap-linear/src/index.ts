import { createHash } from "node:crypto";
import type { LocalToolHandler } from "@render-harness/core";
import { type ConnectorContribution, definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };
import { type LinearFilterConfig, normalizeLinearEvent } from "./normalize.js";
import { type LinearAccessMode, linearTools } from "./tools.js";
import { verifyLinearWebhook } from "./verify.js";

interface LinearConfig extends LinearFilterConfig {
  agent?: string;
  userId?: string;
  webhookSecretEnv?: string;
  apiKeyEnv?: string;
  accessMode?: LinearAccessMode;
}

const DEFAULT_WEBHOOK_SECRET_ENV = "LINEAR_WEBHOOK_SECRET";
const DEFAULT_API_KEY_ENV = "LINEAR_API_KEY";

const pack = definePack({
  name: "cap-linear",
  version: pkg.version,
  envSchema: [
    {
      name: DEFAULT_WEBHOOK_SECRET_ENV,
      required: true,
      secret: true,
      description: "Linear webhook signing secret.",
    },
    {
      name: DEFAULT_API_KEY_ENV,
      required: true,
      secret: true,
      description: "Linear API key used for read tools and optional write tools.",
    },
  ],
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    const apiKey = ctx.env(cfg.apiKeyEnv);
    if (!apiKey) throw new Error(`cap-linear: ${cfg.apiKeyEnv} is not set`);
    return linearTools({ apiKey, accessMode: cfg.accessMode });
  },
  connectors(ctx: PackContext): ConnectorContribution[] {
    const cfg = readConfig(ctx.config);
    return [
      {
        key: "linear",
        webhook: async (req, webCtx) => {
          const rawBody = await req.text();
          const parsed = parseBody(rawBody);
          const secret = ctx.env(cfg.webhookSecretEnv);
          if (!secret) return json({ error: "missing_secret", env: cfg.webhookSecretEnv }, 500);
          const verifyArgs = {
            rawBody,
            secret,
            signature: req.headers.get("linear-signature"),
          };
          const timestamp = timestampFrom(parsed);
          if (
            !verifyLinearWebhook({
              ...verifyArgs,
              ...(timestamp !== undefined ? { timestamp } : {}),
            })
          ) {
            return json({ error: "invalid_signature" }, 401);
          }

          const normalized = normalizeLinearEvent(parsed, cfg);
          if (!normalized) return json({ ok: true, skipped: true });
          const agent = webCtx.resolveAgent(cfg.agent);
          const runId = `linear-${hash(deliverySeed(parsed, rawBody))}`;
          const result = await webCtx.enqueueRun({
            agentName: agent.name,
            agentVersion: agent.version,
            userId: cfg.userId ?? "cap-linear",
            runId,
            initialContent: [{ type: "text", text: normalized.summary }],
            metadata: { connector: "cap-linear", ...normalized },
          });
          return json(result, result.status === "enqueued" ? 202 : 200);
        },
      },
    ];
  },
});

export default pack;

type ResolvedLinearConfig = Required<
  Pick<LinearConfig, "webhookSecretEnv" | "apiKeyEnv" | "accessMode">
> &
  Omit<LinearConfig, "webhookSecretEnv" | "apiKeyEnv" | "accessMode">;

function readConfig(raw: Record<string, unknown>): ResolvedLinearConfig {
  const cfg: ResolvedLinearConfig = {
    webhookSecretEnv: stringValue(raw.webhookSecretEnv) ?? DEFAULT_WEBHOOK_SECRET_ENV,
    apiKeyEnv: stringValue(raw.apiKeyEnv) ?? DEFAULT_API_KEY_ENV,
    accessMode: raw.accessMode === "read_write" ? "read_write" : "read",
  };
  const agent = stringValue(raw.agent);
  if (agent) cfg.agent = agent;
  const userId = stringValue(raw.userId);
  if (userId) cfg.userId = userId;
  const allowedTeams = stringArray(raw.allowedTeams);
  if (allowedTeams) cfg.allowedTeams = allowedTeams;
  const allowedProjects = stringArray(raw.allowedProjects);
  if (allowedProjects) cfg.allowedProjects = allowedProjects;
  const states = stringArray(raw.states);
  if (states) cfg.states = states;
  const labels = stringArray(raw.labels);
  if (labels) cfg.labels = labels;
  const ignoredActors = stringArray(raw.ignoredActors);
  if (ignoredActors) cfg.ignoredActors = ignoredActors;
  return cfg;
}

function parseBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function timestampFrom(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const found = (value as Record<string, unknown>).webhookTimestamp;
  return typeof found === "number" ? found : undefined;
}

function deliverySeed(value: unknown, rawBody: string): string {
  if (!value || typeof value !== "object") return rawBody;
  const payload = value as Record<string, unknown>;
  return [
    stringValue(payload.organizationId),
    stringValue(payload.type),
    stringValue(payload.action),
    stringAt(payload, "data.id"),
    stringAt(payload, "data.updatedAt"),
    stringAt(payload, "data.createdAt"),
  ]
    .filter(Boolean)
    .join(":");
}

function stringAt(value: unknown, path: string): string | undefined {
  let cursor = value;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return stringValue(cursor);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}
