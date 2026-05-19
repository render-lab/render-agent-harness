# @render-harness/cap-google

Google Workspace capability pack for the [Render Agent Harness](https://github.com/render-lab/render-agent-harness). Five opt-in surfaces:

- **Gmail** (default) — search, read, send, modify labels.
- **Calendar** (default) — list, get, freebusy, create, update, delete events.
- **Drive** — list, search, read (with Doc/Sheet/Slide export to text), upload.
- **Docs** — read (body flattened to markdown-like text), create, append text.
- **Sheets** — read range, append row, update range, create sheet, read metadata.

Unlike `cap-slack` / `cap-github` which use a single deployment-wide bot token, this pack uses the harness's **per-end-user OAuth connection API**: each end user clicks "Connect Google" in the operator UI, the harness stores their refresh token encrypted, and tools fetch a fresh access token at call time.

## Tools

Gmail (always-on read when `surfaces: [..., gmail, ...]`):

- `gmail.search` — list messages by Gmail query syntax
- `gmail.get_message` — full message + decoded body

Gmail (`accessMode: "read_write"`, default):

- `gmail.send` — send a message (with optional threading)
- `gmail.modify_labels` — add/remove labels

Calendar (always-on read when `surfaces: [..., calendar, ...]`):

- `calendar.list_events`
- `calendar.get_event`
- `calendar.freebusy`

Calendar (`accessMode: "read_write"`):

- `calendar.create_event`
- `calendar.update_event`
- `calendar.delete_event`

Drive (always-on read when `surfaces: [..., drive, ...]`):

- `drive.list_files` — Drive query passthrough
- `drive.search` — convenience wrapper around name + mime_type
- `drive.read_file` — exports Google-native types to text; metadata stub for binary

Drive (`accessMode: "read_write"`):

- `drive.upload_file` — create a plain-text or HTML file (folder placement optional)

Docs (always-on read when `surfaces: [..., docs, ...]`):

- `docs.read_doc` — body flattened to markdown-style text

Docs (`accessMode: "read_write"`):

- `docs.create_doc`
- `docs.append_text`

Sheets (always-on read when `surfaces: [..., sheets, ...]`):

- `sheets.read_range`
- `sheets.read_sheet_metadata`

Sheets (`accessMode: "read_write"`):

- `sheets.append_row`
- `sheets.update_range`
- `sheets.create_sheet`

## Deployment

1. **Register an OAuth 2.0 client** in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (type: "Web application"). Add this redirect URI:

   ```
   https://your-harness.onrender.com/connections/google/callback
   ```

   In the OAuth consent screen, enable the APIs you'll use: Gmail API, Calendar API, Drive API, Docs API, Sheets API (each one separately in the Google Cloud Console).

2. **Set env vars** on the harness service:

   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `CONNECTIONS_ENCRYPTION_KEY` (generate with `openssl rand -base64 32`)

3. **Add the pack** to `render-harness.yaml`:

   ```yaml
   capabilities:
     - pack: "@render-harness/cap-google"
       config:
         accessMode: "read_write"           # or "read"
         surfaces: [gmail, calendar]        # default; opt in to drive, docs, sheets
   ```

4. **Connect**: open the operator UI → Connections tab → click "Connect Google".

## Config

| Key | Type | Default | What it does |
|---|---|---|---|
| `accessMode` | `"read"` \| `"read_write"` | `"read_write"` | `read` drops the write tools and narrows OAuth scopes to the `.readonly` variants |
| `surfaces` | `("gmail" \| "calendar" \| "drive" \| "docs" \| "sheets")[]` | `["gmail", "calendar"]` | Which surfaces to enable. Each entry adds its scopes + its tools. Default matches pre-0.6.1 behaviour exactly so existing users see no change. |
| `clientIdEnv` | string | `GOOGLE_OAUTH_CLIENT_ID` | Override the env var name for the OAuth client id |
| `clientSecretEnv` | string | `GOOGLE_OAUTH_CLIENT_SECRET` | Override the env var name for the OAuth client secret |

## Scopes

Per surface (`read_write` mode shown; `read` mode uses the `.readonly` variant of each):

| Surface | `read` mode | `read_write` mode |
|---|---|---|
| `gmail` | `gmail.readonly` | `gmail.modify` + `gmail.send` |
| `calendar` | `calendar.readonly` | `calendar` |
| `drive` | `drive.readonly` (broader; for browse-and-summarize) | `drive.file` (least-privilege; only files the agent created or the user explicitly shared) |
| `docs` | `documents.readonly` | `documents` |
| `sheets` | `spreadsheets.readonly` | `spreadsheets` |

Plus `userinfo.email` always, which powers the "Connected as foo@example.com" UI label.

Google's "write implies read" rule means `read_write` mode doesn't include the `.readonly` variant for the same surface — that would double-ask on the consent screen.

## Migrating from pre-0.6.1

Default behaviour is unchanged. To opt into new surfaces:

1. Edit `render-harness.yaml`: add `surfaces: [gmail, calendar, drive, docs, sheets]` (or any subset) to the cap-google config.
2. Redeploy.
3. **Each end user needs to reconnect Google** — the new scopes aren't in their existing grant. Open the operator UI → Connections tab → Disconnect Google → Reconnect.

If you forget step 3, the pack's tool errors detect the scope drift and surface an actionable message ("Your Google connection doesn't include drive access — open the Connections tab and reconnect").

## Multi-tenant safety

The harness's `SecretsContext` is constructed per tool invocation scoped to the run's `userId`. A tool cannot ever access another user's connection — there is no path to construct a `SecretsContext` for a different user from inside the handler.

## Local development

```sh
pnpm --filter @render-harness/cap-google test
pnpm --filter @render-harness/cap-google build
```
