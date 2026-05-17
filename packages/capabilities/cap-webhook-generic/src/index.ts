import { createHash } from "node:crypto";
import { type ConnectorContribution, definePack, type PackContext } from "@render-harness/registry";
import { type ExtractConfig, extractWebhookPayload } from "./extract.js";
import { verifyWebhookSignature } from "./verify.js";

interface WebhookGenericConfig extends ExtractConfig {
  agent?: string;
  userId?: string;
  secretEnv?: string;
  signatureHeader?: string;
  signaturePrefix?: string;
  algorithm?: string;
  idHeader?: string;
  requireSignature?: boolean;
}

const DEFAULT_SECRET_ENV = "WEBHOOK_SECRET";
const DEFAULT_SIGNATURE_HEADER = "X-Signature-256";

const pack = definePack({
  name: "cap-webhook-generic",
  version: "0.1.0",
  envSchema: [
    {
      name: DEFAULT_SECRET_ENV,
      required: false,
      secret: true,
      description: "Secret used to verify generic webhook HMAC signatures.",
    },
  ],
  connectors(ctx: PackContext): ConnectorContribution[] {
    const cfg = readConfig(ctx.config);
    return [
      {
        key: "webhook-generic",
        webhook: async (req, webCtx) => {
          const rawBody = await req.text();
          if (cfg.requireSignature) {
            const secret = ctx.env(cfg.secretEnv);
            if (!secret) {
              return json({ error: "missing_secret", env: cfg.secretEnv }, 500);
            }
            const verifyArgs = {
              rawBody,
              signature: req.headers.get(cfg.signatureHeader),
              secret,
              algorithm: cfg.algorithm,
            };
            const ok = verifyWebhookSignature(
              cfg.signaturePrefix ? { ...verifyArgs, prefix: cfg.signaturePrefix } : verifyArgs,
            );
            if (!ok) return json({ error: "invalid_signature" }, 401);
          }

          const parsedBody = parseBody(rawBody);
          const extracted = extractWebhookPayload({
            headers: req.headers,
            parsedBody,
            rawBody,
            config: cfg,
          });
          const agent = webCtx.resolveAgent(cfg.agent);
          const providerDeliveryId = cfg.idHeader ? req.headers.get(cfg.idHeader) : null;
          const runId = `webhook-${hash(providerDeliveryId ?? rawBody)}`;
          const result = await webCtx.enqueueRun({
            agentName: agent.name,
            agentVersion: agent.version,
            userId: cfg.userId ?? "cap-webhook-generic",
            runId,
            initialContent: [{ type: "text", text: extracted.text }],
            metadata: {
              connector: "cap-webhook-generic",
              deliveryId: providerDeliveryId,
              ...extracted.metadata,
            },
          });
          return json(result, result.status === "enqueued" ? 202 : 200);
        },
      },
    ];
  },
});

export default pack;

type ResolvedWebhookGenericConfig = Required<
  Pick<WebhookGenericConfig, "secretEnv" | "signatureHeader" | "algorithm" | "requireSignature">
> &
  Omit<WebhookGenericConfig, "secretEnv" | "signatureHeader" | "algorithm" | "requireSignature">;

function readConfig(raw: Record<string, unknown>): ResolvedWebhookGenericConfig {
  const cfg: ResolvedWebhookGenericConfig = {
    secretEnv: stringValue(raw.secretEnv) ?? DEFAULT_SECRET_ENV,
    signatureHeader: stringValue(raw.signatureHeader) ?? DEFAULT_SIGNATURE_HEADER,
    algorithm: stringValue(raw.algorithm) ?? "sha256",
    requireSignature: raw.requireSignature !== false,
  };
  const agent = stringValue(raw.agent);
  if (agent) cfg.agent = agent;
  const userId = stringValue(raw.userId);
  if (userId) cfg.userId = userId;
  const signaturePrefix = stringValue(raw.signaturePrefix);
  if (signaturePrefix) cfg.signaturePrefix = signaturePrefix;
  const idHeader = stringValue(raw.idHeader);
  if (idHeader) cfg.idHeader = idHeader;
  const textPath = stringValue(raw.textPath);
  if (textPath) cfg.textPath = textPath;
  const textHeader = stringValue(raw.textHeader);
  if (textHeader) cfg.textHeader = textHeader;
  const metadataPaths = recordOfStrings(raw.metadataPaths);
  if (metadataPaths) cfg.metadataPaths = metadataPaths;
  return cfg;
}

function parseBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
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

function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}
