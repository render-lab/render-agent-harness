import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `fetch_url(url)` — HTTP GET with strong defaults.
 *
 *   - Scheme allowlist: http, https.
 *   - SSRF guard: hostname resolves through DNS first; reject if any
 *     resolved address is loopback / private / link-local / unique-local
 *     / IPv4-mapped / multicast / cloud-metadata (169.254.169.254,
 *     fd00:ec2::254). Re-checked on every redirect hop.
 *   - Size cap: 1 MB by default (HARNESS_FETCH_URL_MAX_BYTES).
 *   - Timeout: 15s by default (HARNESS_FETCH_URL_TIMEOUT_MS).
 *   - Redirects: max 3 hops.
 *   - Content-type sniff: text-shaped types decoded as UTF-8; everything
 *     else returns a `<binary content_type=… size=…>` placeholder.
 *
 * The SSRF guard exists because the production Blueprint puts the worker
 * on Render's private network, where the agent's process can reach
 * Postgres, Key Value, and any other internal service. Without the
 * guard, a single prompt-injected message could exfiltrate secrets.
 */
export const fetchUrlFactory: BuiltinFactory = (ctx) => {
  const allowPrivate = ctx.env.HARNESS_FETCH_URL_ALLOW_PRIVATE === "1";
  const maxBytes = clampInt(ctx.env.HARNESS_FETCH_URL_MAX_BYTES, 1_000_000, 1_024, 50_000_000);
  const timeoutMs = clampInt(ctx.env.HARNESS_FETCH_URL_TIMEOUT_MS, 15_000, 1_000, 120_000);
  return {
    registered: true,
    handler: buildHandler({ allowPrivate, maxBytes, timeoutMs }),
  };
};

interface FetchOpts {
  allowPrivate: boolean;
  maxBytes: number;
  timeoutMs: number;
}

const MAX_REDIRECTS = 3;
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const TEXT_CONTENT_TYPES = [
  /^text\//i,
  /^application\/json\b/i,
  /^application\/xml\b/i,
  /^application\/.*\+json\b/i,
  /^application\/.*\+xml\b/i,
  /^application\/javascript\b/i,
  /^application\/x-www-form-urlencoded\b/i,
];

function buildHandler(opts: FetchOpts): LocalToolHandler {
  return {
    definition: {
      name: "fetch_url",
      description:
        "HTTP GET an absolute URL and return the response body. Use for fetching public web pages, JSON APIs, RSS feeds, etc. Blocks private/internal addresses for safety; binary content types return a placeholder rather than raw bytes.",
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            description: "Absolute http(s) URL to fetch.",
          },
          headers: {
            type: "object",
            description:
              "Optional request headers (e.g. Accept). User-Agent, Host, and Content-Length are ignored.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["url"],
      },
    },
    handler: async ({ input, signal }) => fetchUrl(input, signal, opts),
  };
}

interface ParsedInput {
  url: string;
  headers?: Record<string, string>;
}

async function fetchUrl(
  rawInput: unknown,
  signal: AbortSignal,
  opts: FetchOpts,
): Promise<{ content: string; isError?: boolean }> {
  const parsed = (rawInput ?? {}) as ParsedInput;
  if (!parsed.url || typeof parsed.url !== "string") {
    return { content: "fetch_url: missing or invalid `url`", isError: true };
  }

  let target: URL;
  try {
    target = new URL(parsed.url);
  } catch {
    return { content: `fetch_url: "${parsed.url}" is not a valid URL`, isError: true };
  }

  let redirectsRemaining = MAX_REDIRECTS;
  let current = target;

  const headers = sanitizeHeaders(parsed.headers);
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const combined = anySignal([signal, timeout]);

  while (true) {
    if (!ALLOWED_SCHEMES.has(current.protocol)) {
      return {
        content: `fetch_url: scheme "${current.protocol}" is not allowed (only http/https)`,
        isError: true,
      };
    }

    if (!opts.allowPrivate) {
      const guard = await checkSsrf(current);
      if (!guard.ok) {
        return {
          content: `fetch_url: refusing to fetch ${current.href} — ${guard.reason}`,
          isError: true,
        };
      }
    }

    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted) {
        return {
          content: `fetch_url: timed out after ${opts.timeoutMs}ms fetching ${current.href}`,
          isError: true,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `fetch_url: network error fetching ${current.href}: ${msg}`, isError: true };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return {
          content: `fetch_url: ${res.status} redirect with no Location header from ${current.href}`,
          isError: true,
        };
      }
      if (redirectsRemaining <= 0) {
        return {
          content: `fetch_url: too many redirects fetching ${target.href} (cap ${MAX_REDIRECTS})`,
          isError: true,
        };
      }
      try {
        current = new URL(location, current);
      } catch {
        return {
          content: `fetch_url: redirect target "${location}" is not a valid URL`,
          isError: true,
        };
      }
      redirectsRemaining -= 1;
      continue;
    }

    return await renderResponse(res, current, opts.maxBytes);
  }
}

async function renderResponse(
  res: Response,
  finalUrl: URL,
  maxBytes: number,
): Promise<{ content: string; isError?: boolean }> {
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const isText = TEXT_CONTENT_TYPES.some((re) => re.test(contentType));

  const body = await readWithCap(res, maxBytes);

  if (!isText) {
    return {
      content: `<binary url="${finalUrl.href}" status=${res.status} content_type="${contentType || "unknown"}" size=${body.byteLength}>`,
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(body.bytes);
  } catch (err) {
    return {
      content: `fetch_url: failed to decode body as UTF-8: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  const header = `# fetch_url ${res.status} ${finalUrl.href}\n# content-type: ${contentType || "unknown"}\n`;
  const footer = body.truncated
    ? `\n\n[... truncated at ${maxBytes} bytes; full body was at least ${body.bytesSeen} bytes ...]`
    : "";
  if (res.status >= 400) {
    return { content: `${header}\n${text}${footer}`, isError: true };
  }
  return { content: `${header}\n${text}${footer}` };
}

interface BodyResult {
  bytes: Uint8Array;
  byteLength: number;
  truncated: boolean;
  bytesSeen: number;
}

async function readWithCap(res: Response, maxBytes: number): Promise<BodyResult> {
  if (!res.body) {
    return { bytes: new Uint8Array(0), byteLength: 0, truncated: false, bytesSeen: 0 };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let bytesSeen = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesSeen += value.byteLength;
    if (total + value.byteLength > maxBytes) {
      const room = Math.max(0, maxBytes - total);
      if (room > 0) chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // already aborted, ignore
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: out, byteLength: total, truncated, bytesSeen: truncated ? bytesSeen : total };
}

interface SsrfResult {
  ok: boolean;
  reason?: string;
}

async function checkSsrf(url: URL): Promise<SsrfResult> {
  const rawHost = url.hostname;
  if (!rawHost) return { ok: false, reason: "missing hostname" };
  // URL.hostname returns "[::1]" for bracketed IPv6 literals; isIP() only
  // accepts the unbracketed form.
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  // Reject DNS rebinding entirely by resolving and checking every address;
  // if any one is private the host is rejected.
  let addresses: { address: string; family: number }[];
  if (isIP(host) !== 0) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch (err) {
      return { ok: false, reason: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  for (const a of addresses) {
    const reason = privateAddressReason(a.address);
    if (reason) {
      return { ok: false, reason: `${a.address} is ${reason}` };
    }
  }
  return { ok: true };
}

/**
 * Returns a non-empty reason string when `addr` is in a class we refuse to
 * fetch. Returns `null` for safe public unicast addresses.
 *
 * Uses ipaddr.js's RFC-correct range tables instead of hand-rolled CIDR
 * matching — handles IPv6 abbreviations, ipv4-mapped addresses, and every
 * RFC-defined reserved class consistently.
 */
function privateAddressReason(addr: string): string | null {
  const family = isIP(addr);
  if (family === 0) return "not a recognised IP";

  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(addr);
  } catch {
    return "malformed IP";
  }

  // Drill through ipv4-mapped (::ffff:a.b.c.d) so the embedded v4's range
  // (private, loopback, etc.) is what gets checked, not just "ipv4Mapped".
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }

  if (parsed.kind() === "ipv4") {
    const range = (parsed as ipaddr.IPv4).range();
    return range === "unicast" ? null : `IPv4 ${range}`;
  }
  const range = (parsed as ipaddr.IPv6).range();
  return range === "unicast" ? null : `IPv6 ${range}`;
}

function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  const banned = new Set(["host", "user-agent", "content-length", "connection", "cookie"]);
  for (const [k, v] of Object.entries(headers)) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    if (banned.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  if (!Object.keys(out).some((k) => k.toLowerCase() === "user-agent")) {
    out["User-Agent"] = "render-harness/fetch_url";
  }
  if (!Object.keys(out).some((k) => k.toLowerCase() === "accept")) {
    out["Accept"] = "*/*";
  }
  return out;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  // Node 22 has AbortSignal.any natively; fall back if not.
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
