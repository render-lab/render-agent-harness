---
name: notion-databases
description: Query, create, and update rows in Notion databases via cap-notion.
when_to_use: When the user wants to read or write structured records (tasks, contacts, project trackers) backed by a Notion database.
---

# Working with Notion databases

A Notion database is a typed collection of pages. cap-notion exposes:

- `notion.query_database({ database_id, filter?, sorts?, page_size?, start_cursor? })` — filter and paginate rows.
- `notion.create_database_row({ database_id, properties, children? })` — insert a row.
- `notion.update_database_row({ page_id, properties })` — patch row properties.

Plus `notion.search({ filter_type: "database" })` to find the database id by name.

## Properties

Database rows are pages, and pages have `properties` matching the database's schema. Each property has a type (`title`, `rich_text`, `select`, `multi_select`, `number`, `checkbox`, `date`, `people`, `relation`, etc.). The wire format is verbose but follows Notion's shape.

Read flow: query the database first → look at one row's `properties` → mimic the shape for new rows / updates.

Common property shapes:

```json
"Name":   { "title":      [{ "type": "text", "text": { "content": "..." } }] }
"Notes":  { "rich_text":  [{ "type": "text", "text": { "content": "..." } }] }
"Status": { "select":     { "name": "In Progress" } }
"Tags":   { "multi_select": [{ "name": "urgent" }, { "name": "billing" }] }
"Due":    { "date":       { "start": "2026-06-01" } }
"Done":   { "checkbox":   true }
"Count":  { "number":     42 }
```

For updates, only include the properties you want to change.

## Filtering

The `filter` argument is a passthrough JSON matching Notion's REST API. v1 doesn't abstract it because Notion's filter DSL is rich and inventing a slim wrapper would be lossy. Examples:

```json
// Status equals "In Progress"
{ "property": "Status", "select": { "equals": "In Progress" } }

// Due date is in the next 7 days
{ "property": "Due", "date": { "next_week": {} } }

// AND across multiple conditions
{ "and": [
    { "property": "Status", "select": { "equals": "Open" } },
    { "property": "Priority", "select": { "does_not_equal": "Low" } }
] }
```

See https://developers.notion.com/reference/post-database-query#filter-object for the full operator list.

## Sorting and pagination

`sorts` is also passthrough:

```json
[{ "property": "Due", "direction": "ascending" }]
```

When `query_database` reports `(more available; pass start_cursor=...)`, pass that string as `start_cursor` to fetch the next page.

## When not to use

- For full-text content within a row, use `notion.read_page({ page_id: <row-id> })` — a database row is a page, and `query_database` only returns properties + last_edited_time, not the body.
- For workspace-wide search across pages AND databases, use `notion.search`.
