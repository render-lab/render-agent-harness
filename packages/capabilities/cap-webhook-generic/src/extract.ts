export interface ExtractConfig {
  textPath?: string;
  textHeader?: string;
  metadataPaths?: Record<string, string>;
}

export interface ExtractedWebhook {
  text: string;
  metadata: Record<string, unknown>;
}

export function extractWebhookPayload(args: {
  headers: Headers;
  parsedBody: unknown;
  rawBody: string;
  config?: ExtractConfig;
}): ExtractedWebhook {
  const cfg = args.config ?? {};
  const headerText = cfg.textHeader ? args.headers.get(cfg.textHeader) : null;
  const pathText = cfg.textPath ? readPath(args.parsedBody, cfg.textPath) : undefined;
  const text = stringifyText(headerText ?? pathText ?? args.parsedBody ?? args.rawBody);
  const metadata: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(cfg.metadataPaths ?? {})) {
    const value = readPath(args.parsedBody, path);
    if (value !== undefined) metadata[key] = value;
  }
  return { text, metadata };
}

export function readPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  let cursor = value;
  for (const part of path.split(".")) {
    if (!part) return undefined;
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function stringifyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}
