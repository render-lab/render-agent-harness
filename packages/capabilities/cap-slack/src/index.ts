import { createHash } from "node:crypto";
import type { LocalToolHandler } from "@render-harness/core";
import { type ConnectorContribution, definePack, type PackContext } from "@render-harness/registry";
import { slackConversationId } from "./convid.js";
import { normalizeSlackEvent, type SlackNormalizeConfig } from "./normalize.js";
import { type SlackAccessMode, slackTools } from "./tools.js";
import { verifySlackSignature } from "./verify.js";

interface SlackConfig extends SlackNormalizeConfig {
  agent?: string;
  userId?: string;
  signingSecretEnv?: string;
  botTokenEnv?: string;
  accessMode?: SlackAccessMode;
}

const DEFAULT_SIGNING_SECRET_ENV = "SLACK_SIGNING_SECRET";
const DEFAULT_BOT_TOKEN_ENV = "SLACK_BOT_TOKEN";

const pack = definePack({
  name: "cap-slack",
  version: "0.1.0",
  envSchema: [
    {
      name: DEFAULT_SIGNING_SECRET_ENV,
      required: true,
      secret: true,
      description: "Slack signing secret used to verify Events API requests.",
    },
    {
      name: DEFAULT_BOT_TOKEN_ENV,
      required: true,
      secret: true,
      description: "Slack bot token used for read tools and optional write tools.",
    },
  ],
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    const botToken = ctx.env(cfg.botTokenEnv);
    if (!botToken) throw new Error(`cap-slack: ${cfg.botTokenEnv} is not set`);
    return slackTools({
      botToken,
      accessMode: cfg.accessMode,
      ...(cfg.allowedChannels ? { allowedChannels: cfg.allowedChannels } : {}),
    });
  },
  connectors(ctx: PackContext): ConnectorContribution[] {
    const cfg = readConfig(ctx.config);
    return [
      {
        key: "slack",
        webhook: async (req, webCtx) => {
          const rawBody = await req.text();
          const signingSecret = ctx.env(cfg.signingSecretEnv);
          if (!signingSecret) {
            return json({ error: "missing_secret", env: cfg.signingSecretEnv }, 500);
          }
          if (
            !verifySlackSignature({
              rawBody,
              signingSecret,
              signature: req.headers.get("x-slack-signature"),
              timestamp: req.headers.get("x-slack-request-timestamp"),
            })
          ) {
            return json({ error: "invalid_signature" }, 401);
          }

          const parsed = parseBody(rawBody);
          const normalized = normalizeSlackEvent(parsed, cfg);
          if (normalized.kind === "challenge") return json({ challenge: normalized.challenge });
          if (normalized.kind === "noop")
            return json({ ok: true, skipped: true, reason: normalized.reason });

          const agent = webCtx.resolveAgent(cfg.agent);
          const conversationId = slackConversationId({
            teamId: normalized.teamId,
            channel: normalized.channel,
            threadTs: normalized.threadTs,
          });
          const result = await webCtx.enqueueIntoConversation({
            conversationId,
            agentName: agent.name,
            agentVersion: agent.version,
            userId: cfg.userId ?? "cap-slack",
            runId: `slack-${hash(normalized.eventId)}`,
            title: `Slack ${normalized.channel}/${normalized.threadTs}`,
            initialContent: [{ type: "text", text: normalized.text }],
            metadata: {
              connector: "cap-slack",
              teamId: normalized.teamId,
              channel: normalized.channel,
              threadTs: normalized.threadTs,
              ts: normalized.ts,
              ...(normalized.userId ? { userId: normalized.userId } : {}),
            },
          });
          return json(result, result.status === "enqueued" ? 202 : 200);
        },
      },
    ];
  },
});

export default pack;

type ResolvedSlackConfig = Required<
  Pick<SlackConfig, "signingSecretEnv" | "botTokenEnv" | "accessMode" | "includeEdits">
> &
  Omit<SlackConfig, "signingSecretEnv" | "botTokenEnv" | "accessMode" | "includeEdits">;

function readConfig(raw: Record<string, unknown>): ResolvedSlackConfig {
  const cfg: ResolvedSlackConfig = {
    signingSecretEnv: stringValue(raw.signingSecretEnv) ?? DEFAULT_SIGNING_SECRET_ENV,
    botTokenEnv: stringValue(raw.botTokenEnv) ?? DEFAULT_BOT_TOKEN_ENV,
    accessMode: raw.accessMode === "read_write" ? "read_write" : "read",
    includeEdits: raw.includeEdits === true,
  };
  const agent = stringValue(raw.agent);
  if (agent) cfg.agent = agent;
  const userId = stringValue(raw.userId);
  if (userId) cfg.userId = userId;
  const allowedChannels = stringArray(raw.allowedChannels);
  if (allowedChannels) cfg.allowedChannels = allowedChannels;
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
