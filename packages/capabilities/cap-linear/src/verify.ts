import { LinearWebhookClient } from "@linear/sdk/webhooks";

export function verifyLinearWebhook(args: {
  rawBody: string;
  signature: string | null;
  secret: string;
  timestamp?: number;
}): boolean {
  if (!args.signature) return false;
  try {
    return new LinearWebhookClient(args.secret).verify(
      Buffer.from(args.rawBody),
      args.signature,
      args.timestamp,
    );
  } catch {
    return false;
  }
}
