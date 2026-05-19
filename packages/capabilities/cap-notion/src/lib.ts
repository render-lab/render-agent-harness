/**
 * Shared HTTP client for the Notion API.
 *
 * Notion requires a `Notion-Version` header on every request. We use
 * the stable 2022-06-28 surface which covers pages, blocks, databases,
 * search, users — everything cap-notion v1 needs. Newer endpoints
 * (e.g. file uploads) ship under later versions and aren't used here.
 */

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2022-06-28";

export interface NotionFetchArgs {
  accessToken: string;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Override the fetch impl, useful for tests. */
  fetchImpl?: typeof fetch;
}

export interface NotionApiError extends Error {
  status: number;
  code?: string;
  notionMessage?: string;
}

/**
 * Make an authenticated Notion API call. On non-2xx, throws a
 * `NotionApiError` with the parsed error body when available.
 *
 * Notion error responses look like:
 *   { object: "error", status: 401, code: "unauthorized", message: "..." }
 *
 * We surface that as a typed error so tool handlers can map
 * `unauthorized` / `restricted_resource` to "ask the user to
 * reconnect" without parsing strings.
 */
export async function notionFetch<T>(args: NotionFetchArgs): Promise<T> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(`${NOTION_API_BASE}${args.path}`, {
    method: args.method ?? "GET",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "notion-version": NOTION_API_VERSION,
      ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const errBody = (parsed ?? {}) as { code?: string; message?: string };
    const err = new Error(
      `Notion API ${res.status} ${args.method ?? "GET"} ${args.path}: ${
        errBody.message ?? text.slice(0, 200)
      }`,
    ) as NotionApiError;
    err.status = res.status;
    if (errBody.code) err.code = errBody.code;
    if (errBody.message) err.notionMessage = errBody.message;
    throw err;
  }
  return parsed as T;
}

/**
 * Heuristic to flatten a Notion block tree into plain text for
 * agent consumption. v1 only handles top-level blocks (paragraph,
 * heading_*, bulleted_list_item, numbered_list_item, to_do, quote,
 * callout, code, divider). Child pages and sub-block trees are
 * indicated with an inline `[has children]` marker — agents call
 * `notion.read_page` again on the child to descend.
 */
export function flattenBlocks(blocks: unknown[]): string {
  const lines: string[] = [];
  for (const raw of blocks) {
    const b = raw as {
      type?: string;
      has_children?: boolean;
      paragraph?: { rich_text?: RichTextItem[] };
      heading_1?: { rich_text?: RichTextItem[] };
      heading_2?: { rich_text?: RichTextItem[] };
      heading_3?: { rich_text?: RichTextItem[] };
      bulleted_list_item?: { rich_text?: RichTextItem[] };
      numbered_list_item?: { rich_text?: RichTextItem[] };
      to_do?: { rich_text?: RichTextItem[]; checked?: boolean };
      quote?: { rich_text?: RichTextItem[] };
      callout?: { rich_text?: RichTextItem[] };
      code?: { rich_text?: RichTextItem[]; language?: string };
      divider?: Record<string, never>;
      child_page?: { title?: string };
      child_database?: { title?: string };
    };
    switch (b.type) {
      case "paragraph":
        lines.push(richTextPlain(b.paragraph?.rich_text));
        break;
      case "heading_1":
        lines.push(`# ${richTextPlain(b.heading_1?.rich_text)}`);
        break;
      case "heading_2":
        lines.push(`## ${richTextPlain(b.heading_2?.rich_text)}`);
        break;
      case "heading_3":
        lines.push(`### ${richTextPlain(b.heading_3?.rich_text)}`);
        break;
      case "bulleted_list_item":
        lines.push(`- ${richTextPlain(b.bulleted_list_item?.rich_text)}`);
        break;
      case "numbered_list_item":
        lines.push(`1. ${richTextPlain(b.numbered_list_item?.rich_text)}`);
        break;
      case "to_do":
        lines.push(`${b.to_do?.checked ? "[x]" : "[ ]"} ${richTextPlain(b.to_do?.rich_text)}`);
        break;
      case "quote":
        lines.push(`> ${richTextPlain(b.quote?.rich_text)}`);
        break;
      case "callout":
        lines.push(`> ${richTextPlain(b.callout?.rich_text)}`);
        break;
      case "code": {
        const lang = b.code?.language ?? "";
        lines.push(`\`\`\`${lang}\n${richTextPlain(b.code?.rich_text)}\n\`\`\``);
        break;
      }
      case "divider":
        lines.push("---");
        break;
      case "child_page":
        lines.push(`[child page: ${b.child_page?.title ?? "(untitled)"}]`);
        break;
      case "child_database":
        lines.push(`[child database: ${b.child_database?.title ?? "(untitled)"}]`);
        break;
      default:
        if (b.has_children) lines.push(`[${b.type ?? "unknown"} block — has children]`);
    }
  }
  return lines.join("\n");
}

interface RichTextItem {
  plain_text?: string;
  text?: { content?: string };
}

function richTextPlain(items: RichTextItem[] | undefined): string {
  if (!items || items.length === 0) return "";
  return items.map((i) => i.plain_text ?? i.text?.content ?? "").join("");
}
