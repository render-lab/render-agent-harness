---
name: notion-pages
description: Search, read, create, and update Notion pages via cap-notion.
when_to_use: When the user mentions a Notion page (by name or URL) or asks you to write something into Notion. Pair with notion-databases when the target is a database row.
---

# Working with Notion pages

The cap-notion pack exposes four page-level tools when configured `read_write`:

- `notion.search({ query, filter_type?, page_size? })` — find pages and databases by title.
- `notion.read_page({ page_id, include_properties?, block_limit? })` — get metadata + flattened block content.
- `notion.create_page({ parent_page_id?, parent_database_id?, properties, children? })` — create a new page under a parent page OR row in a database.
- `notion.append_blocks({ page_id, children })` — add blocks to the bottom of a page.
- `notion.update_page_properties({ page_id, properties?, archived? })` — patch properties or archive.

In `read` mode the pack only ships `search` + `read_page`.

## Workflow

1. If the user gives you a page by name (not URL), call `notion.search` first to get the page id. Notion ids are UUIDs (with or without dashes); both forms work.
2. `notion.read_page` returns top-level blocks flattened to markdown-like text. Child pages and sub-blocks are noted with `[has children]` markers — call `read_page` again on the child id to descend (v1 has no recursive walk to keep token costs predictable).
3. Writes (`create_page`, `append_blocks`, `update_page_properties`) require `accessMode: read_write` on the pack config. If the agent's permissions list these under `requireApproval`, the harness pauses for human review.

## Block shape

Notion blocks are nested JSON. Common shapes the agent should know:

```json
{ "object": "block", "type": "paragraph",
  "paragraph": { "rich_text": [{ "type": "text", "text": { "content": "Hello." } }] } }

{ "object": "block", "type": "heading_2",
  "heading_2": { "rich_text": [{ "type": "text", "text": { "content": "My heading" } }] } }

{ "object": "block", "type": "to_do",
  "to_do": { "rich_text": [{ "type": "text", "text": { "content": "Task" } }], "checked": false } }

{ "object": "block", "type": "code",
  "code": { "language": "typescript",
            "rich_text": [{ "type": "text", "text": { "content": "console.log(1)" } }] } }
```

You can pass these arrays directly as the `children` arg to `create_page` / `append_blocks`.

## Permissions in Notion

OAuth grants the integration access to the workspace, but **per-page/database access is granted separately** by the user via Notion's "Add connections" menu (top-right `•••` on any page). If a tool call returns `restricted_resource`, the user hasn't shared that page with the integration yet — tell them to open the page in Notion and "Add connections" → pick your integration.

## When not to use

- Real-time fetches of fresh web content — use `fetch_url` or `web_search`.
- Storing one-off facts the user wants you to remember across runs — use `cap-memory-pg.write` instead. Notion is for content the user owns / collaborates on; memory-pg is for the agent's private state.
