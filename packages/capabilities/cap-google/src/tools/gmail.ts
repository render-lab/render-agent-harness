/**
 * Gmail tool set.
 *
 * Tools use the Gmail REST API v1
 * (https://developers.google.com/gmail/api/reference/rest). Each tool
 * is namespaced under `gmail.` (which the registry rewrites to
 * `cap-google__gmail_<name>` when the agent is loaded).
 *
 * Available scopes determine which tools you get back:
 *   - `read` mode  → `gmail.search`, `gmail.get_message`
 *   - `read_write` mode → adds `gmail.send`, `gmail.modify_labels`
 *
 * Read tools tolerate the read scope only; write tools require the
 * Gmail modify + send scopes. The pack contributes both sets when
 * `accessMode === "read_write"` (the default); set `accessMode: "read"`
 * to expose only the read tools.
 */

import type { LocalToolHandler } from "@render-harness/core";
import { defineGoogleTool, googleFetch, objectSchema } from "../lib.js";
import type { GoogleAccessMode } from "../oauth.js";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

export function gmailTools(args: { accessMode: GoogleAccessMode }): LocalToolHandler[] {
  const tools: LocalToolHandler[] = [
    // ----------------------------------------------------------------
    // gmail.search — list messages matching a Gmail query
    // ----------------------------------------------------------------
    defineGoogleTool<{ query?: string; max_results?: number; label_ids?: string[] }>({
      name: "gmail.search",
      description:
        'Search the user\'s Gmail inbox using Gmail\'s query language (https://support.google.com/mail/answer/7190). Example queries: "is:unread", "from:alice@example.com newer_than:7d", "subject:invoice". Returns up to `max_results` (default 25) message stubs with id, threadId, and snippet. Use gmail.get_message to fetch headers and body.',
      inputSchema: objectSchema({
        query: { type: "string", description: "Gmail search query.", optional: true },
        max_results: {
          type: "number",
          description: "Max messages to return (1-100). Default 25.",
          optional: true,
        },
        label_ids: {
          type: "array",
          description: "Limit to messages with these label IDs (e.g. INBOX, STARRED).",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        const max = clampInt(input.max_results, 1, 100, 25);
        const url = `${GMAIL_BASE}/users/me/messages`;
        const list = (await googleFetch(url, {
          accessToken,
          query: {
            q: input.query ?? "",
            maxResults: max,
          },
          signal,
        })) as { messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number };

        const messages = list.messages ?? [];
        if (messages.length === 0) {
          return { messages: [], resultSizeEstimate: list.resultSizeEstimate ?? 0 };
        }

        // Hydrate each id with a metadata-format fetch so the response is
        // self-contained — the model otherwise immediately calls
        // gmail.get_message on every id, wasting a turn.
        const hydrated = await Promise.all(
          messages.map(async (m) => {
            const detail = (await googleFetch(`${GMAIL_BASE}/users/me/messages/${m.id}`, {
              accessToken,
              query: { format: "metadata", metadataHeaders: "From,To,Subject,Date" },
              signal,
            })) as {
              id: string;
              threadId: string;
              snippet?: string;
              labelIds?: string[];
              payload?: { headers?: Array<{ name?: string; value?: string }> };
            };
            return {
              id: detail.id,
              threadId: detail.threadId,
              snippet: detail.snippet ?? "",
              labelIds: detail.labelIds ?? [],
              headers: extractHeaders(detail.payload?.headers, ["From", "To", "Subject", "Date"]),
            };
          }),
        );
        return {
          messages: hydrated,
          resultSizeEstimate: list.resultSizeEstimate ?? hydrated.length,
        };
      },
    }),

    // ----------------------------------------------------------------
    // gmail.get_message — fetch one message including the decoded body
    // ----------------------------------------------------------------
    defineGoogleTool<{ message_id: string }>({
      name: "gmail.get_message",
      description:
        "Fetch one Gmail message by id and return the headers plus the decoded plain-text body (preferred) or HTML body. Use gmail.search to find message ids first.",
      inputSchema: objectSchema({
        message_id: { type: "string", description: "The message id returned by gmail.search." },
      }),
      call: async ({ input, accessToken, signal }) => {
        const id = input.message_id;
        if (!id) throw new Error("message_id is required");
        const msg = (await googleFetch(
          `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(id)}`,
          {
            accessToken,
            query: { format: "full" },
            signal,
          },
        )) as GmailFullMessage;
        return {
          id: msg.id,
          threadId: msg.threadId,
          labelIds: msg.labelIds ?? [],
          snippet: msg.snippet ?? "",
          headers: extractHeaders(msg.payload?.headers, [
            "From",
            "To",
            "Cc",
            "Bcc",
            "Subject",
            "Date",
            "Message-Id",
          ]),
          body: extractBody(msg.payload),
        };
      },
    }),
  ];

  if (args.accessMode !== "read_write") return tools;

  tools.push(
    // ----------------------------------------------------------------
    // gmail.send — send a new email
    // ----------------------------------------------------------------
    defineGoogleTool<{
      to: string | string[];
      subject: string;
      body: string;
      cc?: string | string[];
      bcc?: string | string[];
      reply_to_message_id?: string;
      thread_id?: string;
    }>({
      name: "gmail.send",
      description:
        "Send an email from the connected Google account. Supports plain-text body, multiple recipients, optional cc/bcc, and threading (pass thread_id to keep the message in an existing thread).",
      inputSchema: objectSchema({
        to: {
          type: "string",
          description: "Single recipient email or array of recipients.",
        },
        subject: { type: "string", description: "Subject line." },
        body: { type: "string", description: "Plain-text body of the email." },
        cc: { type: "string", description: "Optional cc recipient(s).", optional: true },
        bcc: { type: "string", description: "Optional bcc recipient(s).", optional: true },
        thread_id: {
          type: "string",
          description: "Existing thread id to reply within.",
          optional: true,
        },
        reply_to_message_id: {
          type: "string",
          description:
            "Optional message id this is a reply to (sets In-Reply-To / References headers).",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        const raw = buildRfc2822(input);
        const encoded = base64UrlEncode(Buffer.from(raw, "utf8"));
        const body: { raw: string; threadId?: string } = { raw: encoded };
        if (input.thread_id) body.threadId = input.thread_id;
        return googleFetch(`${GMAIL_BASE}/users/me/messages/send`, {
          accessToken,
          method: "POST",
          body,
          signal,
        });
      },
    }),

    // ----------------------------------------------------------------
    // gmail.modify_labels — add/remove labels on a message
    // ----------------------------------------------------------------
    defineGoogleTool<{
      message_id: string;
      add_label_ids?: string[];
      remove_label_ids?: string[];
    }>({
      name: "gmail.modify_labels",
      description:
        "Add and/or remove Gmail labels on a message. Use to archive (remove INBOX), mark as read (remove UNREAD), star (add STARRED), or apply custom labels by id.",
      inputSchema: objectSchema({
        message_id: { type: "string", description: "Message id." },
        add_label_ids: {
          type: "array",
          description: "Label ids to add.",
          optional: true,
        },
        remove_label_ids: {
          type: "array",
          description: "Label ids to remove.",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        const body: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
        if (input.add_label_ids?.length) body.addLabelIds = input.add_label_ids;
        if (input.remove_label_ids?.length) body.removeLabelIds = input.remove_label_ids;
        if (!body.addLabelIds && !body.removeLabelIds) {
          throw new Error("provide at least one of add_label_ids or remove_label_ids");
        }
        return googleFetch(
          `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(input.message_id)}/modify`,
          {
            accessToken,
            method: "POST",
            body,
            signal,
          },
        );
      },
    }),
  );

  return tools;
}

// --------------------------------------------------------------------
// Wire helpers
// --------------------------------------------------------------------

interface GmailFullMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
}

interface GmailPayload {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

function extractHeaders(
  headers: Array<{ name?: string; value?: string }> | undefined,
  wanted: string[],
): Record<string, string> {
  if (!headers) return {};
  const lowerWanted = new Map(wanted.map((w) => [w.toLowerCase(), w]));
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (typeof h.name !== "string" || typeof h.value !== "string") continue;
    const canonical = lowerWanted.get(h.name.toLowerCase());
    if (canonical) out[canonical] = h.value;
  }
  return out;
}

/**
 * Pick the best body to surface to the model: plain-text part if any,
 * otherwise the HTML part decoded to its raw HTML string. Walks nested
 * `multipart/*` payloads.
 */
function extractBody(payload: GmailPayload | undefined): {
  mimeType: string;
  text: string;
} | null {
  if (!payload) return null;
  const plain = findPartByMime(payload, "text/plain");
  if (plain?.body?.data) {
    return { mimeType: "text/plain", text: decodeBase64Url(plain.body.data) };
  }
  const html = findPartByMime(payload, "text/html");
  if (html?.body?.data) {
    return { mimeType: "text/html", text: decodeBase64Url(html.body.data) };
  }
  if (payload.body?.data) {
    return { mimeType: payload.mimeType ?? "text/plain", text: decodeBase64Url(payload.body.data) };
  }
  return null;
}

function findPartByMime(payload: GmailPayload, mime: string): GmailPayload | null {
  if (payload.mimeType === mime) return payload;
  for (const part of payload.parts ?? []) {
    const hit = findPartByMime(part, mime);
    if (hit) return hit;
  }
  return null;
}

function decodeBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

interface SendInput {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to_message_id?: string;
  thread_id?: string;
}

/**
 * Build an RFC 2822 message string suitable for Gmail's `messages.send`.
 * Headers are folded conservatively; non-ASCII subject lines get
 * RFC 2047 encoded so Gmail accepts them without mangling.
 */
export function buildRfc2822(input: SendInput): string {
  const lines: string[] = [];
  lines.push(`To: ${joinAddresses(input.to)}`);
  if (input.cc) lines.push(`Cc: ${joinAddresses(input.cc)}`);
  if (input.bcc) lines.push(`Bcc: ${joinAddresses(input.bcc)}`);
  lines.push(`Subject: ${encodeSubject(input.subject)}`);
  if (input.reply_to_message_id) {
    lines.push(`In-Reply-To: ${input.reply_to_message_id}`);
    lines.push(`References: ${input.reply_to_message_id}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(input.body);
  return lines.join("\r\n");
}

function joinAddresses(value: string | string[]): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

function encodeSubject(subject: string): string {
  // RFC 2047 encoded-word for any non-ASCII content. Simpler than
  // building a full quoted-printable encoder — base64 the whole thing
  // when needed.
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}
