---
name: google-sheets
description: Read ranges, append rows, update cells, and create Google Sheets.
when_to_use: When the user references a Google Sheet, asks you to pull tabular data, or wants you to record results in a sheet.
---

# Working with Google Sheets

When `cap-google` is configured with `surfaces: [..., sheets, ...]` it exposes:

- `sheets.read_sheet_metadata({ spreadsheet_id })` — list the tabs in a spreadsheet with their titles, sheetIds, and grid dimensions.
- `sheets.read_range({ spreadsheet_id, range, major_dimension? })` — fetch values from an A1 range.
- `sheets.append_row({ spreadsheet_id, range, values })` — append rows to the bottom of an existing table (read_write only).
- `sheets.update_range({ spreadsheet_id, range, values })` — overwrite cells in a specific range (read_write only).
- `sheets.create_sheet({ title, sheet_titles? })` — create a brand-new spreadsheet (read_write only).

The `spreadsheet_id` is the alphanumeric string between `/d/` and `/edit` in a Sheet URL.

## A1 notation

All `range` arguments use A1 notation:

- `"A1:C10"` — first sheet, columns A-C, rows 1-10.
- `"Sheet2!B2:D5"` — named tab, B2-D5.
- `"Sheet1!A:C"` — all rows in columns A-C (useful with `append_row` to target a table).
- `"Sheet1!A1"` — single cell anchor, useful with `append_row` (Sheets finds the first empty row after the anchor).

If you don't know the tab names, call `read_sheet_metadata` first.

## Read flow

`sheets.read_range` returns:

```json
{
  "range": "Sheet1!A1:C3",
  "majorDimension": "ROWS",
  "values": [
    ["Header1", "Header2", "Header3"],
    ["row1c1", "row1c2", "row1c3"],
    ["row2c1", "row2c2", "row2c3"]
  ]
}
```

Note that Google omits trailing empty rows and trailing empty cells in a row, so the actual array dimensions can be smaller than the requested range. Handle this when computing row counts.

## Write flows

**Append a row to a table:**

```
sheets.append_row({
  spreadsheet_id: "...",
  range: "Sheet1!A:C",            // points at the table; Sheets finds the first empty row after it
  values: [["2026-05-19", "agent-summary", "ok"]]
})
```

`values` is always 2D — pass one row as `[[...]]`, multiple rows as `[[...], [...]]`.

**Overwrite specific cells:**

```
sheets.update_range({
  spreadsheet_id: "...",
  range: "Sheet1!B2:D2",          // exact cells
  values: [["foo", "bar", "baz"]] // shape must match the range
})
```

The range's row × column dimensions must match `values` exactly.

**Create a new spreadsheet:**

```
sheets.create_sheet({
  title: "Agent results 2026-05-19",
  sheet_titles: ["Summary", "Details"]  // optional; default is one "Sheet1" tab
})
```

Returns the new `spreadsheetId` and `spreadsheetUrl` ready to share.

## Common patterns

- **"Find a row by ID and update its status":** read_range to pull the ID column, find the row index in JS, then update_range with `RowN:RowN`.
- **"Log a result to a tracking sheet":** append_row with a single row of values.
- **"Pull a table for the model to analyze":** read_range with the full table range, return values to the agent for analysis.

## What this skill doesn't cover

- **Formatting** (cell colors, font sizes, conditional formatting). Not exposed in v1.
- **Charts, pivot tables, filters.** Not exposed.
- **Formulas vs literal values.** Both read and write use `USER_ENTERED` mode — strings starting with `=` are treated as formulas. Quote them with a leading apostrophe if you want a literal `=value` string.

## Scopes

The pack requests `spreadsheets` scope (read+write) in `accessMode: read_write`, or `spreadsheets.readonly` in `accessMode: read`. Scope-drift errors mean the user opted into the sheets surface after connecting — they need to disconnect and reconnect at the operator UI.
