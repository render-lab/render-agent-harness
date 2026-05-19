/**
 * Verify the HMAC-SHA1 signature Intercom puts on every webhook
 * delivery. The signature header is `X-Hub-Signature` with value
 * `sha1=<hex>` where `<hex>` is the HMAC-SHA1 of the raw request
 * body using the OAuth app's `client_secret` as the key.
 *
 * Reference:
 * https://developers.intercom.com/building-apps/docs/webhooks#section-signed-notifications
 *
 * Use `timingSafeEqual` to avoid leaking timing info on mismatches.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyIntercomSignature(args: {
  rawBody: string;
  clientSecret: string;
  signature: string | null;
}): boolean {
  if (!args.signature?.startsWith("sha1=")) return false;
  const expected = `sha1=${createHmac("sha1", args.clientSecret).update(args.rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(args.signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
