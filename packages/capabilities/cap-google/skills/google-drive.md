---
name: google-drive
description: List, search, read, and upload files in the user's Google Drive.
when_to_use: When the user references a Drive file (by name or URL), asks you to summarize a document, or wants you to drop a result file in Drive.
---

# Working with Google Drive

When `cap-google` is configured with `surfaces: [..., drive, ...]` it exposes:

- `drive.list_files({ q?, page_size?, page_token? })` — arbitrary Drive search query (see [Drive query syntax](https://developers.google.com/drive/api/guides/search-files)).
- `drive.search({ name, mime_type?, page_size? })` — convenience wrapper that builds a `name contains '...' and trashed=false` query.
- `drive.read_file({ file_id, export_mime? })` — read content. Google-native files (Docs/Sheets/Slides) export to text; binary files return a metadata stub.
- `drive.upload_file({ name, content, mime_type?, parent_folder_id? })` — create a new file in Drive (read_write only).

## When the user mentions a file by name

1. Use `drive.search` to find the file id. Filter by `mime_type` if you know the type — e.g. `application/vnd.google-apps.document` for Docs, `application/vnd.google-apps.spreadsheet` for Sheets, `application/pdf` for PDFs.
2. Call `drive.read_file({ file_id })`. The tool handles Google-native export automatically — Docs → text, Sheets → CSV, Slides → text.
3. For binary files (PDFs, images), `drive.read_file` returns a metadata stub with a hint. Don't try to summarize the bytes; instead ask the user to share a text export, or use the file's `webViewLink` with `web_extract` / `fetch_url` if the file is public.

## When the user asks you to write a file

Default to plain text:

```
drive.upload_file({
  name: "agent-summary.txt",
  content: "<your text>",
  // mime_type: "text/plain"  // default
  // parent_folder_id: "..."  // omit to land in My Drive root
})
```

For richer formats, use the per-surface tools:
- Google Doc → `docs.create_doc({ title, body })` from the `google-docs` skill.
- Google Sheet → `sheets.create_sheet({ title })` then `sheets.append_row(...)` from `google-sheets`.

## Scopes and the migration hint

The pack uses `drive.file` scope (least-privilege) when `accessMode: read_write` — the agent only sees files it created or files the user explicitly shared with the OAuth app. In `accessMode: read` the pack uses the broader `drive.readonly` scope for browse-and-summarize workflows.

If you get `Your Google connection doesn't include drive access`, the user opted into `surfaces: [drive]` after they had already connected Google with the previous scope set. They need to open the Connections tab in the operator UI, disconnect Google, and reconnect. Tell them so plainly.

## When not to use

- Real-time fetches of public web pages → `fetch_url` or `web_search` are cheaper.
- Storing private agent state across runs → `cap-memory-pg` is the right tool. Drive is for content the user owns.
