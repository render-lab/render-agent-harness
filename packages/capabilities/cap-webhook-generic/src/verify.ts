import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyWebhookOptions {
  rawBody: string;
  signature: string | null;
  secret: string;
  algorithm?: string;
  prefix?: string;
}

export function verifyWebhookSignature(opts: VerifyWebhookOptions): boolean {
  if (!opts.signature || opts.secret.length === 0) return false;
  const algorithm = opts.algorithm ?? "sha256";
  const expected = createHmac(algorithm, opts.secret).update(opts.rawBody).digest("hex");
  const actual = opts.prefix ? stripPrefix(opts.signature, opts.prefix) : opts.signature;
  if (!actual) return false;

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(actual, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function stripPrefix(value: string, prefix: string): string | null {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}
