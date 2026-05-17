import { createHash } from "node:crypto";
import type { LocalToolHandler } from "@render-harness/core";
import { type ConnectorContribution, definePack, type PackContext } from "@render-harness/registry";
import { type GitHubFilterConfig, normalizeGitHubEvent } from "./normalize.js";
import { type GitHubAccessMode, githubTools } from "./tools.js";
import { verifyGitHubSignature } from "./verify.js";

interface GitHubConfig extends GitHubFilterConfig {
  agent?: string;
  userId?: string;
  webhookSecretEnv?: string;
  tokenEnv?: string;
  accessMode?: GitHubAccessMode;
}

const DEFAULT_WEBHOOK_SECRET_ENV = "GITHUB_WEBHOOK_SECRET";
const DEFAULT_TOKEN_ENV = "GITHUB_TOKEN";

const pack = definePack({
  name: "cap-github",
  version: "0.1.0",
  envSchema: [
    {
      name: DEFAULT_WEBHOOK_SECRET_ENV,
      required: true,
      secret: true,
      description: "GitHub webhook secret.",
    },
    {
      name: DEFAULT_TOKEN_ENV,
      required: true,
      secret: true,
      description: "GitHub token used for read tools and optional write tools.",
    },
  ],
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    const token = ctx.env(cfg.tokenEnv);
    if (!token) throw new Error(`cap-github: ${cfg.tokenEnv} is not set`);
    return githubTools({ token, accessMode: cfg.accessMode });
  },
  connectors(ctx: PackContext): ConnectorContribution[] {
    const cfg = readConfig(ctx.config);
    return [
      {
        key: "github",
        webhook: async (req, webCtx) => {
          const rawBody = await req.text();
          const secret = ctx.env(cfg.webhookSecretEnv);
          if (!secret) return json({ error: "missing_secret", env: cfg.webhookSecretEnv }, 500);
          if (
            !verifyGitHubSignature({
              rawBody,
              secret,
              signature: req.headers.get("x-hub-signature-256"),
            })
          ) {
            return json({ error: "invalid_signature" }, 401);
          }

          const event = req.headers.get("x-github-event") ?? "";
          const delivery = req.headers.get("x-github-delivery");
          const parsed = parseBody(rawBody);
          const normalized = normalizeGitHubEvent(event, parsed, cfg);
          if (!normalized) return json({ ok: true, skipped: true });
          const agent = webCtx.resolveAgent(cfg.agent);
          const result = await webCtx.enqueueRun({
            agentName: agent.name,
            agentVersion: agent.version,
            userId: cfg.userId ?? "cap-github",
            runId: `github-${hash(delivery ?? rawBody)}`,
            initialContent: [{ type: "text", text: normalized.summary }],
            metadata: {
              connector: "cap-github",
              deliveryId: delivery,
              ...normalized,
            },
          });
          return json(result, result.status === "enqueued" ? 202 : 200);
        },
      },
    ];
  },
});

export default pack;

type ResolvedGitHubConfig = Required<
  Pick<GitHubConfig, "webhookSecretEnv" | "tokenEnv" | "accessMode">
> &
  Omit<GitHubConfig, "webhookSecretEnv" | "tokenEnv" | "accessMode">;

function readConfig(raw: Record<string, unknown>): ResolvedGitHubConfig {
  const cfg: ResolvedGitHubConfig = {
    webhookSecretEnv: stringValue(raw.webhookSecretEnv) ?? DEFAULT_WEBHOOK_SECRET_ENV,
    tokenEnv: stringValue(raw.tokenEnv) ?? DEFAULT_TOKEN_ENV,
    accessMode: raw.accessMode === "read_write" ? "read_write" : "read",
  };
  const agent = stringValue(raw.agent);
  if (agent) cfg.agent = agent;
  const userId = stringValue(raw.userId);
  if (userId) cfg.userId = userId;
  const allowedRepositories = stringArray(raw.allowedRepositories);
  if (allowedRepositories) cfg.allowedRepositories = allowedRepositories;
  const events = stringArray(raw.events);
  if (events) cfg.events = events;
  const branches = stringArray(raw.branches);
  if (branches) cfg.branches = branches;
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
