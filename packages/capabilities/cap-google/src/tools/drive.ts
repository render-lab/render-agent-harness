/**
 * Google Drive tool set.
 *
 * Tools use the Drive REST API v3
 * (https://developers.google.com/drive/api/v3/reference). Mounted
 * when `surfaces` includes `"drive"`. Read tools work in either
 * accessMode; write tools (`upload_file`) require `read_write`.
 *
 * Default scope when read_write is `drive.file` (least-privilege —
 * only files the agent created or the user explicitly shared with
 * the OAuth app). In `read` mode the broader `drive.readonly` scope
 * is requested so agents can browse the user's whole Drive for
 * summarization workflows.
 *
 * Mime-type handling on read: Google-native types (docs, sheets,
 * slides) must be exported because they're not raw files. We export
 * Docs to `text/plain` and Sheets to `text/csv` so the agent gets
 * usable content. For binary types (images, PDFs, etc.), we return
 * a metadata stub and tell the agent to summarize via web_extract /
 * fetch_url instead of trying to read the bytes.
 */

import type { LocalToolHandler } from "@render-harness/core";
import { defineGoogleTool, googleFetch, objectSchema, withScopeHint } from "../lib.js";
import type { GoogleAccessMode } from "../oauth.js";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

export function driveTools(args: { accessMode: GoogleAccessMode }): LocalToolHandler[] {
  const tools: LocalToolHandler[] = [
    // ----------------------------------------------------------------
    // drive.list_files — list files matching a Drive query
    // ----------------------------------------------------------------
    defineGoogleTool<{ q?: string; page_size?: number; page_token?: string }>({
      name: "drive.list_files",
      description:
        "List files visible to the OAuth app. Pass an optional Drive query string (https://developers.google.com/drive/api/guides/search-files) like \"mimeType='application/vnd.google-apps.document'\" or \"name contains 'invoice' and trashed=false\". Returns id, name, mimeType, modifiedTime, and the web view URL.",
      inputSchema: objectSchema({
        q: {
          type: "string",
          description: "Drive search query. Omit to list all visible files.",
          optional: true,
        },
        page_size: {
          type: "number",
          description: "Max files per page (1-1000). Default 25.",
          optional: true,
        },
        page_token: {
          type: "string",
          description: "Pagination cursor from a previous response.",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        return withScopeHint("drive", async () => {
          const query: Record<string, string | number | undefined> = {
            pageSize: clampInt(input.page_size, 1, 1000, 25),
            fields:
              "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, parents, size)",
          };
          if (input.q) query.q = input.q;
          if (input.page_token) query.pageToken = input.page_token;
          return await googleFetch(`${DRIVE_BASE}/files`, {
            accessToken,
            query,
            signal,
          });
        });
      },
    }),

    // ----------------------------------------------------------------
    // drive.search — convenience wrapper that builds a name-contains query
    // ----------------------------------------------------------------
    defineGoogleTool<{ name: string; mime_type?: string; page_size?: number }>({
      name: "drive.search",
      description:
        'Search Drive for files whose name contains the given string. Optionally restrict by mimeType (e.g. "application/vnd.google-apps.document" for Docs, "application/vnd.google-apps.spreadsheet" for Sheets). Use drive.list_files for arbitrary Drive query syntax.',
      inputSchema: objectSchema({
        name: { type: "string", description: "Substring to match against the file name." },
        mime_type: {
          type: "string",
          description: "Optional mimeType filter (full string, not extension).",
          optional: true,
        },
        page_size: {
          type: "number",
          description: "Max files (1-100). Default 25.",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.name) throw new Error("name is required");
        return withScopeHint("drive", async () => {
          const escaped = input.name.replace(/'/g, "\\'");
          const clauses: string[] = [`name contains '${escaped}'`, "trashed=false"];
          if (input.mime_type) {
            clauses.push(`mimeType='${input.mime_type.replace(/'/g, "\\'")}'`);
          }
          return await googleFetch(`${DRIVE_BASE}/files`, {
            accessToken,
            query: {
              q: clauses.join(" and "),
              pageSize: clampInt(input.page_size, 1, 100, 25),
              fields: "files(id, name, mimeType, modifiedTime, webViewLink, parents)",
            },
            signal,
          });
        });
      },
    }),

    // ----------------------------------------------------------------
    // drive.read_file — fetch file content, exporting Google-native types
    // ----------------------------------------------------------------
    defineGoogleTool<{ file_id: string; export_mime?: string }>({
      name: "drive.read_file",
      description:
        "Read a Drive file's content. For Google-native types (Docs, Sheets, Slides) the file is exported to text — Docs to text/plain, Sheets to text/csv, Slides to text/plain. For binary/uploaded files (PDFs, images), a metadata stub is returned with a hint to use web_extract on the webViewLink instead. Pass `export_mime` to override the export MIME for Google-native files.",
      inputSchema: objectSchema({
        file_id: { type: "string", description: "Drive file id." },
        export_mime: {
          type: "string",
          description:
            "Override export mimeType for Google-native files. Common values: text/plain, text/csv, text/html, application/pdf.",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.file_id) throw new Error("file_id is required");
        return withScopeHint("drive", async () => {
          // Get metadata first to decide between alt=media and export.
          const meta = (await googleFetch(
            `${DRIVE_BASE}/files/${encodeURIComponent(input.file_id)}`,
            {
              accessToken,
              query: { fields: "id, name, mimeType, modifiedTime, webViewLink, size" },
              signal,
            },
          )) as {
            id: string;
            name: string;
            mimeType: string;
            modifiedTime?: string;
            webViewLink?: string;
            size?: string;
          };

          const googleMime = isGoogleNativeMime(meta.mimeType);
          if (googleMime) {
            const exportMime = input.export_mime ?? defaultExportMime(meta.mimeType);
            const exportUrl = `${DRIVE_BASE}/files/${encodeURIComponent(input.file_id)}/export?mimeType=${encodeURIComponent(exportMime)}`;
            const text = await fetchTextOrThrow(exportUrl, accessToken, signal);
            return {
              id: meta.id,
              name: meta.name,
              mimeType: meta.mimeType,
              exportedAs: exportMime,
              modifiedTime: meta.modifiedTime,
              webViewLink: meta.webViewLink,
              content: text,
            };
          }

          if (isTextMime(meta.mimeType)) {
            const url = `${DRIVE_BASE}/files/${encodeURIComponent(input.file_id)}?alt=media`;
            const text = await fetchTextOrThrow(url, accessToken, signal);
            return {
              id: meta.id,
              name: meta.name,
              mimeType: meta.mimeType,
              modifiedTime: meta.modifiedTime,
              webViewLink: meta.webViewLink,
              content: text,
            };
          }

          // Binary type — don't download bytes through the tool.
          return {
            id: meta.id,
            name: meta.name,
            mimeType: meta.mimeType,
            size: meta.size,
            modifiedTime: meta.modifiedTime,
            webViewLink: meta.webViewLink,
            note:
              "Binary file — content not returned. Use web_extract on webViewLink if the file is public, " +
              "or ask the user to share a text export.",
          };
        });
      },
    }),
  ];

  if (args.accessMode !== "read_write") return tools;

  tools.push(
    // ----------------------------------------------------------------
    // drive.upload_file — create a new plain-text or HTML file
    // ----------------------------------------------------------------
    defineGoogleTool<{
      name: string;
      content: string;
      mime_type?: string;
      parent_folder_id?: string;
    }>({
      name: "drive.upload_file",
      description:
        "Create a new file in Drive with the given text content. Defaults to mimeType=\"text/plain\". Pass parent_folder_id to create the file inside a folder; otherwise it lands in the user's My Drive root. Returns the new file's id and webViewLink.",
      inputSchema: objectSchema({
        name: { type: "string", description: "File name (e.g. 'agent-summary.txt')." },
        content: { type: "string", description: "Text content." },
        mime_type: {
          type: "string",
          description: "MIME type. Defaults to text/plain.",
          optional: true,
        },
        parent_folder_id: {
          type: "string",
          description: "Optional Drive folder id to create the file inside.",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.name || !input.content) throw new Error("name and content are required");
        return withScopeHint("drive", async () => {
          const mime = input.mime_type ?? "text/plain";
          const metadata: Record<string, unknown> = { name: input.name, mimeType: mime };
          if (input.parent_folder_id) metadata.parents = [input.parent_folder_id];
          // Multipart upload — boundary + JSON metadata part + content part.
          const boundary = `cap-google-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const body =
            `--${boundary}\r\n` +
            "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
            `${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: ${mime}; charset=UTF-8\r\n\r\n` +
            `${input.content}\r\n` +
            `--${boundary}--`;
          const res = await fetch(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink",
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": `multipart/related; boundary=${boundary}`,
              },
              body,
              ...(signal ? { signal } : {}),
            },
          );
          const text = await res.text();
          if (!res.ok) {
            throw new Error(`Google Drive upload ${res.status}: ${text.slice(0, 400)}`);
          }
          return JSON.parse(text);
        });
      },
    }),
  );

  return tools;
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function isGoogleNativeMime(mime: string): boolean {
  return mime.startsWith("application/vnd.google-apps.");
}

function defaultExportMime(googleMime: string): string {
  if (googleMime === "application/vnd.google-apps.spreadsheet") return "text/csv";
  if (googleMime === "application/vnd.google-apps.presentation") return "text/plain";
  // Default for Google Docs and anything else — text/plain is the
  // safest sink for a model.
  return "text/plain";
}

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/x-yaml"
  );
}

async function fetchTextOrThrow(
  url: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google Drive ${res.status}: ${text.slice(0, 400)}`);
  }
  return text;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
