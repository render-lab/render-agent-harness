# @render-harness/cap-google

Google Workspace (Gmail + Calendar) capability pack for the [Render Agent Harness](https://github.com/render-lab/render-agent-harness).

Unlike `cap-slack` / `cap-github` which use a single deployment-wide bot token, this pack uses the harness's **per-end-user OAuth connection API**: each end user clicks "Connect Google" in the operator UI, the harness stores their refresh token encrypted, and tools fetch a fresh access token at call time.

## Tools

Gmail (always-on read):

- `gmail.search` — list messages by Gmail query syntax
- `gmail.get_message` — full message + decoded body

Gmail (`accessMode: "read_write"`, default):

- `gmail.send` — send a message (with optional threading)
- `gmail.modify_labels` — add/remove labels

Calendar (always-on read):

- `calendar.list_events`
- `calendar.get_event`
- `calendar.freebusy`

Calendar (`accessMode: "read_write"`, default):

- `calendar.create_event`
- `calendar.update_event`
- `calendar.delete_event`

## Deployment

1. **Register an OAuth 2.0 client** in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (type: "Web application"). Add this redirect URI:

   ```
   https://your-harness.onrender.com/connections/google/callback
   ```

2. **Set env vars** on the harness service:

   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `CONNECTIONS_ENCRYPTION_KEY` (generate with `openssl rand -base64 32`)

3. **Add the pack** to `render-harness.yaml`:

   ```yaml
   capabilities:
     - pack: "@render-harness/cap-google"
       config:
         accessMode: "read_write"  # or "read"
   ```

4. **Connect**: open the operator UI → Connections tab → click "Connect Google".

## Config

| Key | Type | Default | What it does |
|---|---|---|---|
| `accessMode` | `"read"` \| `"read_write"` | `"read_write"` | `read` drops the send / modify / create tools and narrows OAuth scopes |
| `clientIdEnv` | string | `GOOGLE_OAUTH_CLIENT_ID` | Override the env var name for the OAuth client id |
| `clientSecretEnv` | string | `GOOGLE_OAUTH_CLIENT_SECRET` | Override the env var name for the OAuth client secret |

## Scopes

- `read`: `gmail.readonly`, `calendar.readonly`, `userinfo.email`
- `read_write`: `gmail.modify`, `gmail.send`, `calendar`, `userinfo.email`

`userinfo.email` populates the "Connected as foo@example.com" UI label.

## Multi-tenant safety

The harness's `SecretsContext` is constructed per tool invocation scoped to the run's `userId`. A tool cannot ever access another user's connection — there is no path to construct a `SecretsContext` for a different user from inside the handler.

## Local development

```sh
pnpm --filter @render-harness/cap-google test
pnpm --filter @render-harness/cap-google build
```
