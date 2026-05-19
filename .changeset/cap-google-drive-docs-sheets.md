---
"@render-harness/cap-google": patch
---

**NEW OPT-IN: Drive / Docs / Sheets surfaces.**

Existing `gmail` + `calendar` behaviour is unchanged — default `surfaces: ["gmail", "calendar"]` matches pre-0.6.1 exactly, no migration needed for current users.

Opt in by adding the new surface(s) to the pack config:

```yaml
capabilities:
  - pack: "@render-harness/cap-google"
    config:
      accessMode: read_write
      surfaces: [gmail, calendar, drive, docs, sheets]   # all 5
```

Each new surface adds its tools and scopes:

| Surface | Tools (`read_write` mode) | OAuth scope |
|---|---|---|
| `drive` | `list_files`, `search`, `read_file`, `upload_file` | `drive.file` (least-privilege; only files the agent created or the user explicitly shared) |
| `docs` | `read_doc`, `create_doc`, `append_text` | `documents` |
| `sheets` | `read_range`, `read_sheet_metadata`, `append_row`, `update_range`, `create_sheet` | `spreadsheets` |

In `read` mode, the `.readonly` variant of each scope is requested (`drive` uses the broader `drive.readonly` for browse-and-summarize workflows, since the per-file model isn't useful for read-only browsing).

`drive.read_file` handles Google-native mime types automatically — Docs export to `text/plain`, Sheets to `text/csv`, Slides to `text/plain`. Binary files (PDFs, images) return a metadata stub with a `webViewLink` hint rather than dumping bytes through the tool context.

Three new skills bundle: `google-drive`, `google-docs`, `google-sheets` (loadable via `load_skill` when the corresponding surface is enabled).

A `withScopeHint` helper wraps tool calls so that an `insufficient authentication scopes` / `PERMISSION_DENIED` 403 from Google gets rewritten into an operator-actionable error: `Your Google connection doesn't include <surface> access — open the Connections tab in the operator UI, disconnect Google, and reconnect after adding "<surface>" to the pack's surfaces: config in render-harness.yaml.` Without this, the model would see Google's raw error and have to guess what to tell the user.

**Migrating existing deployments to use new surfaces:**

1. Add the surface to `render-harness.yaml`'s `cap-google.config.surfaces`.
2. Redeploy.
3. Each end user reconnects Google in the operator UI (their existing grant doesn't have the new scopes).

Per Q2=A from the wave-1 shipping plan: opt-in additive feature, default unchanged → patch is defensible. Also a forward-looking note for the next time we add a `surfaces`-style config to another pack: the same scope-drift hint pattern in `withScopeHint` is reusable; see `packages/capabilities/cap-google/src/lib.ts`.
