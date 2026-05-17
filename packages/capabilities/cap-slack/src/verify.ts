import { createHmac, timingSafeEqual } from "node:crypto";

const FIVE_MINUTES_SECONDS = 60 * 5;

export function verifySlackSignature(args: {
  rawBody: string;
  signingSecret: string;
  signature: string | null;
  timestamp: string | null;
  nowSeconds?: number;
}): boolean {
  if (!args.signature?.startsWith("v0=") || !args.timestamp) return false;
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > FIVE_MINUTES_SECONDS) return false;

  const base = `v0:${args.timestamp}:${args.rawBody}`;
  const expected = `v0=${createHmac("sha256", args.signingSecret).update(base).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(args.signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
