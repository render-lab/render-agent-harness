/**
 * Google Docs tool set.
 *
 * Tools use the Docs REST API v1
 * (https://developers.google.com/docs/api/reference/rest). Mounted
 * when `surfaces` includes `"docs"`. Read tools work in either
 * accessMode; write tools (`create_doc`, `append_text`) require
 * `read_write`.
 *
 * Read flow is content-flattening — we walk the document's body
 * elements (paragraphs, lists, tables) and return plain text so the
 * model can summarize without parsing Google's structuredElement
 * representation. The cap-notion equivalent works the same way.
 *
 * Write flow uses `batchUpdate` with insertText / endOfSegmentLocation
 * for appends, the same primitive the official Docs samples
 * recommend.
 */

import type { LocalToolHandler } from "@render-harness/core";
import { defineGoogleTool, googleFetch, objectSchema, withScopeHint } from "../lib.js";
import type { GoogleAccessMode } from "../oauth.js";

const DOCS_BASE = "https://docs.googleapis.com/v1";

export function docsTools(args: { accessMode: GoogleAccessMode }): LocalToolHandler[] {
  const tools: LocalToolHandler[] = [
    // ----------------------------------------------------------------
    // docs.read_doc — fetch a document and flatten body to plain text
    // ----------------------------------------------------------------
    defineGoogleTool<{ document_id: string }>({
      name: "docs.read_doc",
      description:
        "Read a Google Doc and return its title, revisionId, and body flattened to plain text. Headings are prefixed with markdown-style #, ##, ###. Tables and images are noted with `[table M×N]` and `[image]` markers — the agent should fetch the doc in the UI if it needs structured cell access. Use docs.create_doc to create new docs and docs.append_text to add to existing ones.",
      inputSchema: objectSchema({
        document_id: { type: "string", description: "Google Doc id (from the URL)." },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.document_id) throw new Error("document_id is required");
        return withScopeHint("docs", async () => {
          const doc = (await googleFetch(
            `${DOCS_BASE}/documents/${encodeURIComponent(input.document_id)}`,
            { accessToken, signal },
          )) as DocsDocument;
          return {
            documentId: doc.documentId,
            title: doc.title,
            revisionId: doc.revisionId,
            content: flattenDoc(doc),
          };
        });
      },
    }),
  ];

  if (args.accessMode !== "read_write") return tools;

  tools.push(
    // ----------------------------------------------------------------
    // docs.create_doc — create a new Google Doc with optional body
    // ----------------------------------------------------------------
    defineGoogleTool<{ title: string; body?: string }>({
      name: "docs.create_doc",
      description:
        "Create a new Google Doc with the given title and (optionally) initial body text. The body is inserted as a single block of plain text starting at position 1. Returns the new documentId and webViewLink (`https://docs.google.com/document/d/<id>`). For richer initial content, follow up with docs.append_text.",
      inputSchema: objectSchema({
        title: { type: "string", description: "Document title." },
        body: { type: "string", description: "Optional initial body text.", optional: true },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.title) throw new Error("title is required");
        return withScopeHint("docs", async () => {
          const created = (await googleFetch(`${DOCS_BASE}/documents`, {
            accessToken,
            method: "POST",
            body: { title: input.title },
            signal,
          })) as { documentId: string; title?: string };
          if (input.body && input.body.length > 0) {
            await googleFetch(
              `${DOCS_BASE}/documents/${encodeURIComponent(created.documentId)}:batchUpdate`,
              {
                accessToken,
                method: "POST",
                body: {
                  requests: [
                    {
                      insertText: {
                        location: { index: 1 },
                        text: input.body,
                      },
                    },
                  ],
                },
                signal,
              },
            );
          }
          return {
            documentId: created.documentId,
            title: created.title ?? input.title,
            webViewLink: `https://docs.google.com/document/d/${created.documentId}/edit`,
          };
        });
      },
    }),

    // ----------------------------------------------------------------
    // docs.append_text — append text to the end of an existing doc
    // ----------------------------------------------------------------
    defineGoogleTool<{ document_id: string; text: string }>({
      name: "docs.append_text",
      description:
        "Append plain text to the end of an existing Google Doc. The text is inserted at the end of the document body via batchUpdate's endOfSegmentLocation. Pass a newline-terminated string if you want a paragraph break; otherwise the text appends inline.",
      inputSchema: objectSchema({
        document_id: { type: "string", description: "Google Doc id." },
        text: { type: "string", description: "Text to append at the end of the doc." },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.document_id || !input.text) {
          throw new Error("document_id and text are required");
        }
        return withScopeHint("docs", async () => {
          await googleFetch(
            `${DOCS_BASE}/documents/${encodeURIComponent(input.document_id)}:batchUpdate`,
            {
              accessToken,
              method: "POST",
              body: {
                requests: [
                  {
                    insertText: {
                      endOfSegmentLocation: {},
                      text: input.text,
                    },
                  },
                ],
              },
              signal,
            },
          );
          return { documentId: input.document_id, appended: input.text.length };
        });
      },
    }),
  );

  return tools;
}

// --------------------------------------------------------------------
// Body flattening
//
// Walks the Docs API's structuredElement tree (paragraphs, tables,
// lists, sectionBreaks) and emits markdown-like text. Headings are
// detected via the paragraph's namedStyleType (HEADING_1, etc.).
// Tables and images are summarized with a marker instead of dumped.
// --------------------------------------------------------------------

interface DocsDocument {
  documentId: string;
  title?: string;
  revisionId?: string;
  body?: { content?: StructuredElement[] };
}

interface StructuredElement {
  paragraph?: {
    elements?: Array<{ textRun?: { content?: string } }>;
    paragraphStyle?: { namedStyleType?: string };
    bullet?: { listId?: string; nestingLevel?: number };
  };
  table?: { rows?: number; columns?: number };
  sectionBreak?: unknown;
}

function flattenDoc(doc: DocsDocument): string {
  const lines: string[] = [];
  const elements = doc.body?.content ?? [];
  for (const el of elements) {
    if (el.paragraph) {
      const text = (el.paragraph.elements ?? [])
        .map((e) => e.textRun?.content ?? "")
        .join("")
        .replace(/\n+$/, "");
      if (!text) continue;
      const prefix = paragraphPrefix(el.paragraph);
      lines.push(prefix + text);
    } else if (el.table) {
      lines.push(`[table ${el.table.rows ?? "?"}×${el.table.columns ?? "?"}]`);
    } else if (el.sectionBreak) {
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function paragraphPrefix(p: NonNullable<StructuredElement["paragraph"]>): string {
  const style = p.paragraphStyle?.namedStyleType ?? "";
  if (style === "HEADING_1") return "# ";
  if (style === "HEADING_2") return "## ";
  if (style === "HEADING_3") return "### ";
  if (style === "HEADING_4") return "#### ";
  if (style === "HEADING_5") return "##### ";
  if (style === "HEADING_6") return "###### ";
  if (p.bullet) return "- ";
  return "";
}
