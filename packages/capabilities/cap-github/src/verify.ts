import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubSignature(args: {
  rawBody: string;
  signature: string | null;
  secret: string;
}): boolean {
  if (!args.signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", args.secret).update(args.rawBody).digest("hex");
  const actual = args.signature.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(actual, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
