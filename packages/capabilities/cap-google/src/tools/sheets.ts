/**
 * Google Sheets tool set.
 *
 * Tools use the Sheets REST API v4
 * (https://developers.google.com/sheets/api/reference/rest). Mounted
 * when `surfaces` includes `"sheets"`. Read tools work in either
 * accessMode; write tools (`append_row`, `update_range`, `create_sheet`)
 * require `read_write`.
 *
 * v1 tools are deliberately primitive — read range, append row,
 * update range, create sheet, read metadata. Higher-level helpers
 * (insert row in a table, sort by column, etc.) layer on top of
 * these; the agent composes them as needed.
 *
 * Range notation: A1 (default). Pass "Sheet1!A1:C3" to scope to a
 * named tab. Sheets accepts both A1 and R1C1 — A1 is friendlier for
 * the model.
 */

import type { LocalToolHandler } from "@render-harness/core";
import { defineGoogleTool, googleFetch, objectSchema, withScopeHint } from "../lib.js";
import type { GoogleAccessMode } from "../oauth.js";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export function sheetsTools(args: { accessMode: GoogleAccessMode }): LocalToolHandler[] {
  const tools: LocalToolHandler[] = [
    // ----------------------------------------------------------------
    // sheets.read_range — fetch values from a range
    // ----------------------------------------------------------------
    defineGoogleTool<{ spreadsheet_id: string; range: string; major_dimension?: string }>({
      name: "sheets.read_range",
      description:
        'Read a range of cell values from a Google Sheet. Range is in A1 notation, e.g. "A1:C10" (range on the first sheet) or "Sheet2!B2:D5" (range on a named tab). Returns a 2D array `values: string[][]` where each inner array is one row. Empty trailing rows/cells are omitted by Google.',
      inputSchema: objectSchema({
        spreadsheet_id: {
          type: "string",
          description: "Sheets spreadsheet id (from the URL).",
        },
        range: { type: "string", description: 'A1 range, e.g. "Sheet1!A1:C10".' },
        major_dimension: {
          type: "string",
          description: 'Row-major ("ROWS", default) or column-major ("COLUMNS").',
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.spreadsheet_id || !input.range) {
          throw new Error("spreadsheet_id and range are required");
        }
        return withScopeHint("sheets", async () => {
          return await googleFetch(
            `${SHEETS_BASE}/${encodeURIComponent(input.spreadsheet_id)}/values/${encodeURIComponent(input.range)}`,
            {
              accessToken,
              query: {
                majorDimension: input.major_dimension === "COLUMNS" ? "COLUMNS" : "ROWS",
                valueRenderOption: "FORMATTED_VALUE",
              },
              signal,
            },
          );
        });
      },
    }),

    // ----------------------------------------------------------------
    // sheets.read_sheet_metadata — list tabs and their dimensions
    // ----------------------------------------------------------------
    defineGoogleTool<{ spreadsheet_id: string }>({
      name: "sheets.read_sheet_metadata",
      description:
        "List the tabs (sheets) inside a spreadsheet with their titles, sheetIds, indices, and grid dimensions. Useful before reading or writing — confirms the right tab name and bounds.",
      inputSchema: objectSchema({
        spreadsheet_id: { type: "string", description: "Sheets spreadsheet id." },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.spreadsheet_id) throw new Error("spreadsheet_id is required");
        return withScopeHint("sheets", async () => {
          const meta = (await googleFetch(
            `${SHEETS_BASE}/${encodeURIComponent(input.spreadsheet_id)}`,
            {
              accessToken,
              query: {
                fields:
                  "spreadsheetId, properties.title, sheets(properties(sheetId, title, index, gridProperties))",
              },
              signal,
            },
          )) as {
            spreadsheetId: string;
            properties?: { title?: string };
            sheets?: Array<{
              properties?: {
                sheetId: number;
                title: string;
                index: number;
                gridProperties?: { rowCount?: number; columnCount?: number };
              };
            }>;
          };
          return {
            spreadsheetId: meta.spreadsheetId,
            title: meta.properties?.title ?? "",
            sheets: (meta.sheets ?? []).map((s) => s.properties ?? {}),
          };
        });
      },
    }),
  ];

  if (args.accessMode !== "read_write") return tools;

  tools.push(
    // ----------------------------------------------------------------
    // sheets.append_row — append one or more rows to a range
    // ----------------------------------------------------------------
    defineGoogleTool<{
      spreadsheet_id: string;
      range: string;
      values: (string | number | boolean | null)[][];
    }>({
      name: "sheets.append_row",
      description:
        'Append one or more rows to the bottom of an existing table on a Google Sheet. `range` should target the table (e.g. "Sheet1!A:C" or "Sheet1!A1"); Sheets finds the first empty row after the table and inserts there. `values` is a 2D array — each inner array is one row\'s cell values in left-to-right order.',
      inputSchema: objectSchema({
        spreadsheet_id: { type: "string", description: "Sheets spreadsheet id." },
        range: { type: "string", description: "A1 range targeting the table to append to." },
        values: {
          type: "array",
          description: "2D array of cell values. Each inner array is one row.",
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.spreadsheet_id || !input.range || !Array.isArray(input.values)) {
          throw new Error("spreadsheet_id, range, and values are required");
        }
        return withScopeHint("sheets", async () => {
          return await googleFetch(
            `${SHEETS_BASE}/${encodeURIComponent(input.spreadsheet_id)}/values/${encodeURIComponent(input.range)}:append`,
            {
              accessToken,
              method: "POST",
              query: {
                valueInputOption: "USER_ENTERED",
                insertDataOption: "INSERT_ROWS",
              },
              body: { values: input.values },
              signal,
            },
          );
        });
      },
    }),

    // ----------------------------------------------------------------
    // sheets.update_range — overwrite cell values in a specific range
    // ----------------------------------------------------------------
    defineGoogleTool<{
      spreadsheet_id: string;
      range: string;
      values: (string | number | boolean | null)[][];
    }>({
      name: "sheets.update_range",
      description:
        'Overwrite the values in a specific A1 range. The range\'s dimensions must match `values`\'s shape — e.g. "Sheet1!B2:D3" expects 2 rows of 3 columns. Use sheets.append_row for "add a row to the bottom" workflows; use update_range when you know the exact cells to write.',
      inputSchema: objectSchema({
        spreadsheet_id: { type: "string", description: "Sheets spreadsheet id." },
        range: { type: "string", description: "A1 range matching the values shape." },
        values: {
          type: "array",
          description: "2D array of cell values matching the range's dimensions.",
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.spreadsheet_id || !input.range || !Array.isArray(input.values)) {
          throw new Error("spreadsheet_id, range, and values are required");
        }
        return withScopeHint("sheets", async () => {
          return await googleFetch(
            `${SHEETS_BASE}/${encodeURIComponent(input.spreadsheet_id)}/values/${encodeURIComponent(input.range)}`,
            {
              accessToken,
              method: "PUT",
              query: { valueInputOption: "USER_ENTERED" },
              body: { values: input.values },
              signal,
            },
          );
        });
      },
    }),

    // ----------------------------------------------------------------
    // sheets.create_sheet — create a brand-new spreadsheet
    // ----------------------------------------------------------------
    defineGoogleTool<{ title: string; sheet_titles?: string[] }>({
      name: "sheets.create_sheet",
      description:
        "Create a new Google Spreadsheet with the given title and (optionally) named tabs. Returns the new spreadsheetId, spreadsheetUrl, and the created sheet metadata. The new file lands in the connected user's My Drive root unless they later move it.",
      inputSchema: objectSchema({
        title: { type: "string", description: "Spreadsheet title (shows in Drive)." },
        sheet_titles: {
          type: "array",
          description: "Optional tab titles. Default: a single tab called 'Sheet1'.",
          optional: true,
        },
      }),
      call: async ({ input, accessToken, signal }) => {
        if (!input.title) throw new Error("title is required");
        return withScopeHint("sheets", async () => {
          const sheets =
            input.sheet_titles && input.sheet_titles.length > 0
              ? input.sheet_titles.map((t) => ({ properties: { title: t } }))
              : undefined;
          const body: Record<string, unknown> = { properties: { title: input.title } };
          if (sheets) body.sheets = sheets;
          return await googleFetch(SHEETS_BASE, {
            accessToken,
            method: "POST",
            body,
            signal,
          });
        });
      },
    }),
  );

  return tools;
}
