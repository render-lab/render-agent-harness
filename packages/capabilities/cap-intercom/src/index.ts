/**
 * @render-harness/cap-intercom
 *
 * First *dual* inbound+outbound capability pack: combines the
 * chat-surface pattern (cap-slack/cap-github connectors) with the
 * per-end-user OAuth pattern (cap-google/cap-notion connections).
 *
 * Inbound: `POST /connectors/intercom` mounted via the pack's
 * `connectors` slot. HMAC-SHA1 verified using the OAuth app's
 * `client_secret` as the HMAC key (Intercom signs every webhook with
 * this). Subscribes to four conversation topics by default; payloads
 * are normalized and enqueued onto a harness conversation keyed by
 * `intercom-${sha256(workspace_id:conversation_id)}`. Idempotency
 * uses Intercom's notification id so re-deliveries dedupe.
 *
 * Outbound: tools use `secrets.requireConnection("intercom")` to
 * fetch a per-end-user access token at call time. 7 tools in
 * `read_write` mode (2 read-only when `accessMode: "read"`).
 *
 * v1 is workspace-scoped — one Intercom workspace per cap-intercom
 * installation. The `userId` config picks which harness user owns
 * the inbound conversations; tools look up that user's stored
 * Intercom connection at call time.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalToolHandler, OAuthProviderConfig, SkillMetadata } from "@render-harness/core";
import { type ConnectorContribution, definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };
import { intercomConversationId, intercomRunId } from "./convid.js";
import { normalizeIntercomWebhook } from "./normalize.js";
import { INTERCOM_PROVIDER_ID, intercomProvider } from "./oauth.js";
import { type IntercomAccessMode, intercomTools } from "./tools.js";
import { verifyIntercomSignature } from "./verify.js";

export { intercomConversationId, intercomRunId } from "./convid.js";
export { normalizeIntercomWebhook } from "./normalize.js";
export { INTERCOM_PROVIDER_ID, intercomProvider } from "./oauth.js";
export type { IntercomAccessMode } from "./tools.js";
export { verifyIntercomSignature } from "./verify.js";

interface ResolvedIntercomConfig {
  agent?: string;
  userId: string;
  accessMode: IntercomAccessMode;
  clientIdEnv: string;
  clientSecretEnv: string;
}

const DEFAULT_CLIENT_ID_ENV = "INTERCOM_OAUTH_CLIENT_ID";
const DEFAULT_CLIENT_SECRET_ENV = "INTERCOM_OAUTH_CLIENT_SECRET";
const DEFAULT_USER_ID = "cap-intercom";

const pack = definePack({
  name: "cap-intercom",
  version: pkg.version,
  envSchema: [
    {
      name: DEFAULT_CLIENT_ID_ENV,
      required: true,
      secret: false,
      description: "Intercom OAuth app client id (from the Developer Hub).",
    },
    {
      name: DEFAULT_CLIENT_SECRET_ENV,
      required: true,
      secret: true,
      description:
        "Intercom OAuth app client secret. Doubles as the HMAC key for webhook signature verification.",
    },
    {
      name: "CONNECTIONS_ENCRYPTION_KEY",
      required: true,
      secret: true,
      description:
        "32-byte base64 secret used by the harness to encrypt refresh tokens at rest. Generate with `openssl rand -base64 32`.",
    },
  ],
  connectionsRequired: [{ provider: INTERCOM_PROVIDER_ID, scopes: [] }],
  oauthProviders(ctx: PackContext): OAuthProviderConfig[] {
    const cfg = readConfig(ctx.config);
    return [
      intercomProvider({
        clientIdEnv: cfg.clientIdEnv,
        clientSecretEnv: cfg.clientSecretEnv,
      }),
    ];
  },
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    return intercomTools({ accessMode: cfg.accessMode });
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
    return [
      {
        name: "intercom-support",
        description:
          "Triage incoming Intercom conversations: read the transcript, reply or note, assign, tag, close, or snooze.",
        whenToUse:
          "Whenever a webhook delivery from Intercom kicks off a run, OR the user asks you to do something with Intercom (reply to a conversation, close a ticket, list open ones, etc.).",
        contentPath: join(SKILLS_DIR, "intercom-support.md"),
      },
    ];
  },
  connectors(ctx: PackContext): ConnectorContribution[] {
    const cfg = readConfig(ctx.config);
    return [
      {
        key: "intercom",
        webhook: async (req, webCtx) => {
          const clientSecret = ctx.env(cfg.clientSecretEnv);
          if (!clientSecret) {
            return json({ error: "missing_secret", env: cfg.clientSecretEnv }, 500);
          }
          const rawBody = await req.text();
          const signature = req.headers.get("x-hub-signature");
          if (!verifyIntercomSignature({ rawBody, clientSecret, signature })) {
            return json({ error: "invalid_signature" }, 401);
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            return json({ error: "invalid_json" }, 400);
          }
          const normalized = normalizeIntercomWebhook(parsed);
          if (normalized.kind === "noop") {
            return json({ ok: true, skipped: true, reason: normalized.reason });
          }
          const agent = webCtx.resolveAgent(cfg.agent);
          const conversationId = intercomConversationId({
            workspaceId: normalized.workspaceId,
            conversationId: normalized.conversationId,
          });
          const runId = intercomRunId({
            workspaceId: normalized.workspaceId,
            conversationId: normalized.conversationId,
            notificationId: normalized.notificationId,
          });
          const initialText = formatInitialText(normalized);
          const result = await webCtx.enqueueIntoConversation({
            conversationId,
            agentName: agent.name,
            agentVersion: agent.version,
            userId: cfg.userId,
            runId,
            title: `Intercom ${normalized.workspaceId}/${normalized.conversationId}`,
            initialContent: [{ type: "text", text: initialText }],
            metadata: {
              connector: "cap-intercom",
              topic: normalized.topic,
              workspaceId: normalized.workspaceId,
              intercomConversationId: normalized.conversationId,
              notificationId: normalized.notificationId,
              deliveryAttempt: normalized.deliveryAttempt,
              ...(normalized.conversationState
                ? { conversationState: normalized.conversationState }
                : {}),
            },
          });
          return json(result, result.status === "enqueued" ? 202 : 200);
        },
      },
    ];
  },
});

export default pack;

function readConfig(raw: Record<string, unknown>): ResolvedIntercomConfig {
  const accessMode: IntercomAccessMode = raw.accessMode === "read" ? "read" : "read_write";
  const clientIdEnv = stringValue(raw.clientIdEnv) ?? DEFAULT_CLIENT_ID_ENV;
  const clientSecretEnv = stringValue(raw.clientSecretEnv) ?? DEFAULT_CLIENT_SECRET_ENV;
  const userId = stringValue(raw.userId) ?? DEFAULT_USER_ID;
  const agent = stringValue(raw.agent);
  return {
    accessMode,
    clientIdEnv,
    clientSecretEnv,
    userId,
    ...(agent ? { agent } : {}),
  };
}

function stringValue(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function formatInitialText(
  n: Extract<ReturnType<typeof normalizeIntercomWebhook>, { kind: "conversation_event" }>,
): string {
  const author = n.latestMessageAuthor ?? "unknown";
  const body = n.latestMessageBody?.replace(/<[^>]+>/g, " ").trim() ?? "(no body)";
  return [
    `Intercom event: ${n.topic}`,
    `Workspace: ${n.workspaceId}`,
    `Conversation: ${n.conversationId}${n.conversationState ? ` (${n.conversationState})` : ""}`,
    "",
    `Latest message from ${author}:`,
    body,
    "",
    `Use intercom.read_conversation({ conversation_id: "${n.conversationId}" }) to see the full transcript.`,
  ].join("\n");
}
