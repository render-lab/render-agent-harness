---
name: filesystem
description: Read, list, write, and delete files under a configured root directory.
when_to_use: When the user asks you to inspect, edit, or save files. All paths are scoped — you cannot escape the configured root.
---

# Filesystem skill

You have four file tools, all path-scoped to one root directory the operator configured at deploy time:

- `fs.read_file({ path })` — read a UTF-8 text file. Large files are truncated; `fetch_full_result` recovers the full body.
- `fs.list_dir({ path })` — list directory entries with type and (for files) size.
- `fs.write_file({ path, content })` — write a UTF-8 file. Auto-creates parent directories.
- `fs.delete_file({ path })` — remove a file. Refuses to delete directories.

`fs.write_file` and `fs.delete_file` are only available when the pack is configured with `readOnly: false`.

## Path rules

- All `path` arguments are joined to the configured root.
- `..` segments cannot escape the root — attempts return an error.
- Symlinks are resolved with `realpath` and rejected if their target is outside the root.
- Paths can be relative (`docs/notes.md`) or absolute under the root (`/var/data/agent-workspace/docs/notes.md` if root is `/var/data/agent-workspace`).

## Patterns

- **List then read.** Don't assume a path exists — call `fs.list_dir` first when you don't know the layout.
- **Read before write.** When editing an existing file, read it first so you understand the current content.
- **Mention the path in your reply.** When you write or delete, tell the user exactly what changed and where.

## What to avoid

- Don't try to read `/etc/passwd`, `/proc/...`, or anything outside the root. The scope check will refuse.
- Don't write large files (over 1 MB by default) — they're rejected. Split or summarize instead.
- Don't store secrets in files unless the user explicitly asked. The disk may be shared across runs.
