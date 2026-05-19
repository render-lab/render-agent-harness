---
name: figma-files
description: Read Figma files — file structure, node id encoding, when to use read_file vs read_file_nodes.
when_to_use: When the user references a Figma file (by URL or name) or asks you to inspect / summarize design content.
---

# Working with Figma files

The cap-figma pack exposes five file-related tools (read mode adds 0 write tools; `read_write_comments` mode adds 1 — `post_comment`, covered in the figma-comments skill):

- `figma.read_file({ file_key, depth?, ids? })` — read the document tree.
- `figma.read_file_nodes({ file_key, ids, depth? })` — full subtree for specific node ids.
- `figma.read_file_metadata({ file_key })` — name, last_modified, role, thumbnail. Cheap.
- `figma.list_team_projects({ team_id })` — projects in a team.
- `figma.list_project_files({ project_id })` — files in a project.

## Finding the file_key

In a Figma URL like `https://www.figma.com/file/abc123XYZ/My-Design`, the `file_key` is `abc123XYZ`. The user-friendly slug after it (`/My-Design`) is ignored by the API.

If the user only gives you a project or team URL, navigate top-down: `list_team_projects` → `list_project_files` → pick the right `file_key`.

## Why depth=2 by default

`figma.read_file` defaults to `depth: 2` — pages → top-level frames. Figma files can be tens of thousands of nodes deep, and the full document tree blows past the token budget for the model. The depth-2 outline is enough to:

- See the file's named pages.
- Spot top-level frame names ("Login", "Dashboard").
- Decide which node ids to drill into.

Then call `read_file_nodes({ file_key, ids: [<the-frame-id>] })` for the full subtree of just that frame.

If you legitimately need more depth (e.g. the file is small), pass `depth: 4` or `5`. The pack caps at 8 to keep accidental "give me the whole file" calls from breaking the run.

## Node ids

Figma node ids look like `123:456` (page id : node sequence). They're stable across edits — recording one in memory and re-querying later is fine.

`ids: ["123:456", "789:012"]` (max 200 per call per Figma docs) fetches multiple subtrees in one round-trip.

## What to look for in the document tree

The response has `document` at the root with `children` (each is a page). Each page has `children` (frames, components, sections). Common node `type` values worth recognizing:

- `CANVAS` — page (one per `document.children` entry).
- `FRAME` — top-level layout container (usually a screen or component instance).
- `COMPONENT` — reusable component definition.
- `INSTANCE` — usage of a component.
- `TEXT` — text node; the `characters` field is the literal text.
- `RECTANGLE` / `ELLIPSE` / `VECTOR` — primitives.
- `GROUP` — visual grouping.

To extract all text on a page, walk the tree filtering `type: "TEXT"` and concatenating `characters`. The pack doesn't ship a helper because the right shape depends on what you're summarizing.

## Token budgeting

Even at depth 2, a complex file can return tens of KB of JSON. Strategies:

- **Filter by `ids:`** for known nodes — by far the cheapest.
- **Read metadata first.** `read_file_metadata` confirms file_key and surfaces `last_modified` so you can decide whether the cached version is stale.
- **Comments-first triage.** `read_comments` is much cheaper than `read_file` and often tells you what the user actually cares about. See the figma-comments skill.

## When you get 403

A 403 from Figma typically means the connected OAuth scopes don't match the pack's accessMode. The pack surfaces an actionable error pointing at /ui/connections — relay it to the user verbatim. They need to disconnect and reconnect Figma after the operator updates the pack's `accessMode` config.
