---
name: google-docs
description: Read, create, and append text to Google Docs.
when_to_use: When the user references a Google Doc, asks you to draft something into a doc, or wants you to add a paragraph to an existing doc.
---

# Working with Google Docs

When `cap-google` is configured with `surfaces: [..., docs, ...]` it exposes:

- `docs.read_doc({ document_id })` — fetch a doc and return the body flattened to markdown-style text.
- `docs.create_doc({ title, body? })` — create a new doc, optionally with initial body text.
- `docs.append_text({ document_id, text })` — append text to the end of an existing doc.

The `document_id` is the alphanumeric string between `/d/` and `/edit` in a Doc URL.

## Read flow

`docs.read_doc` flattens the body for you. Output includes:

- Headings prefixed with markdown `#`, `##`, `###` so you can preserve structure when summarizing.
- Bulleted/numbered lists prefixed with `- `.
- Tables and images noted with `[table M×N]` and `[image]` markers — these aren't dumped because Google's structured representation is verbose and rarely useful in a chat.

If you need cell-level access to a table embedded in a Doc, prefer Sheets (`sheets.read_range`) when the data is also in a Sheet, or ask the user to share the doc and use the webViewLink.

## Write flow

Two patterns:

**Create a new doc:** `docs.create_doc({ title: "...", body: "..." })`. The body is inserted at position 1 as plain text. Returns the new `documentId` and a `webViewLink` ready to share with the user.

**Append to an existing doc:** `docs.append_text({ document_id, text })`. Insertion is at the end of the document body. **Pass a leading newline if you want a paragraph break**:

```
docs.append_text({
  document_id: "...",
  text: "\n\n## Summary\n\nHere is the bullet list..."
})
```

Without the leading `\n`, the new text appends inline to whatever's currently last.

## What this skill doesn't cover

- **Formatting (bold, lists, headings) on inserted text.** v1 only inserts plain text via `insertText`. Style updates need additional `batchUpdate` requests (updateTextStyle, createParagraphBullets) that aren't exposed yet — call out the limitation to the user and offer to draft a Doc-format markdown they can paste.
- **Tables, images, comments.** Not in v1.
- **Searching across docs.** Use `drive.search({ name: "...", mime_type: "application/vnd.google-apps.document" })` to find docs by title.

## Scopes

The pack requests `documents` scope (read+write) in `accessMode: read_write`, or `documents.readonly` in `accessMode: read`. If you get a scope-drift error, the user needs to disconnect and reconnect Google in the operator UI.
