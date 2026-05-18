# @render-harness/cap-slack

## 0.5.2

### Patch Changes

- cap-slack: name → id lookup now works with `channels:read` alone (no `groups:read` required), and Slack errors get rewritten with actionable hints instead of `An API error occurred: missing_scope`.

  Two fixes that together unblock the most common Slack scope footgun:
  - **Split `conversations.list` by channel kind.** The resolver used to request `types: "public_channel,private_channel"` in a single call. Slack returns `missing_scope: groups:read` for the whole call when any of the requested types is out of scope, even if you only care about the in-scope ones. So bots with the documented `channels:read` scope hit `missing_scope` on every `#channel-name` lookup. Now each kind is requested in a separate call and aggregated with `Promise.allSettled` — public channels resolve fine for bots with `channels:read`, private channels additionally resolve when `groups:read` is granted, and a bot with neither still gets a clean error (now with the actionable formatting below).
  - **`formatSlackError`** rewrites generic `@slack/web-api` platform errors into operator-actionable text:
    - `missing_scope` → `"Slack missing_scope: 'X' needed (bot currently has: 'Y'). Add 'X' to the bot's OAuth scopes in the Slack app config (api.slack.com → OAuth & Permissions → Bot Token Scopes), reinstall the app to the workspace, and redeploy."`
    - `not_in_channel` → `"the bot must be a member of the channel before it can post. Invite it with /invite @<bot-name>"`
    - `channel_not_found` → `"the channel ID is invalid, the bot doesn't have permission to see it, or it has been archived"`
    - `invalid_auth` / `token_revoked` → `"SLACK_BOT_TOKEN is invalid or has been revoked. Re-issue the token from the Slack app config and redeploy."`
    - Any other Slack platform code passes through with the `slack.<code>` suffix appended so the agent can branch on it.

  Regression tests pin both: a bot with `channels:read` only still resolves `#public-channel`, a bot with no read scopes gets the actionable `missing_scope` message naming the missing scope, and `not_in_channel` on `chat.postMessage` rewrites to the invite hint.

  No agent code changes required — both fixes apply automatically on redeploy.

## 0.5.1

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.5.1

## 0.5.0

### Minor Changes

- 2c465b3: Per-end-user OAuth connection API + `cap-google` (Gmail + Calendar).

  This is a coordinated minor cut. Every first-party harness package crosses `0.4 → 0.5` together because the platform additions touch every layer:

  **`@render-harness/core`** — new `OAuthProviderConfig`, encrypted token storage (`agent_user_connections`), per-run `SecretsContext` built from the run's `userId`, refresh-on-use with provider-rotation handling, `NeedsConnectionError`, and a process-level OAuth provider registry. New SQL migration `0004_connections.sql`. `LocalToolHandler.handler` args gain optional `userId` and `secrets: SecretsContext` (additive — existing packs keep compiling).

  **`@render-harness/contracts`** — `UserConnectionSummary`, `ConnectionProviderSummary`, `ConnectionsResp`, `StartConnectionResp`, `DeleteConnectionResp`.

  **`@render-harness/registry`** — `CapabilityPack.oauthProviders` and `connectionsRequired` fields; `defineFromConfig` auto-registers providers from loaded packs.

  **`@render-harness/web`** — `/connections/:provider/start|callback`, `GET /connections`, `DELETE /connections/:provider` routes; Diagnostics surfaces `CONNECTIONS_ENCRYPTION_KEY` and per-provider OAuth client credential checks.

  **`@render-harness/ui`** — new Connections tab in the operator UI; `listConnections` / `startConnection` / `deleteConnection` API helpers.

  **`@render-harness/cap-google`** (new) — Gmail (`gmail.search`, `gmail.get_message`, `gmail.send`, `gmail.modify_labels`) + Calendar (`calendar.list_events`, `calendar.get_event`, `calendar.freebusy`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event`) tools backed by the connection API. Adds Google as the first registered OAuth provider with `access_type=offline` + `prompt=consent` so refresh tokens are returned. Read-only mode (`accessMode: "read"`) drops the write tools and narrows scopes.

  Operators upgrading existing deployments need to:
  1. Set `CONNECTIONS_ENCRYPTION_KEY` (32 random bytes, base64) on the harness service.
  2. For each provider, register an OAuth 2.0 client and set its client id/secret env vars.
  3. Update `harnessVersion` in `render-harness.yaml` and `@render-harness/*` dep ranges in `package.json` to `^0.5.0`.

  See `docs/connections-api.md` for the full design and `docs-site/src/content/docs/connections-api.mdx` for the user-facing guide.

### Patch Changes

- Updated dependencies [2c465b3]
  - @render-harness/registry@0.5.0

## 0.4.2

### Patch Changes

- cap-slack: every tool that takes a channel now accepts `#channel-name` or `@user-handle` in addition to raw IDs.

  Previously the agent had to know the literal `C0AQHA6M3PS` form for every channel; there was no way to translate "send to #general" into a real send because the pack had no reverse lookup. Now every tool that takes a `channel` parameter (`slack.send_message`, `slack.get_thread`, `slack.get_channel_history`, `slack.get_channel_info`, `slack.add_reaction`, `slack.update_message`) accepts any of:
  - A Slack ID — `C0AQHA6M3PS` / `G…` / `D…` — used verbatim, no API call.
  - A `#channel-name` — resolved via `conversations.list` (paged, cached for the agent process). Requires `channels:read` / `groups:read`.
  - An `@user-handle` — resolved via `users.list` (cached) + `conversations.open` to a DM channel. Requires `users:read` + `im:write` + `chat:write`.
  - A Slack mention literal — `<#C0…|name>`, `<@U0…>`. Unwrapped and used.

  `slack.get_user_info` also accepts an `@handle` or bare handle (`ada.l`) in addition to the user ID.

  `allowedChannels` config is enforced **after** resolution against the canonical channel ID, so `allowedChannels: ["C0AQ…"]` correctly accepts `{ channel: "#that-channels-name" }` because the resolver returns `C0AQ…` before the gate check fires.

  When the bot is missing a lookup scope (e.g. `chat:write` only, no `channels:read`), the tool returns a clear error naming the missing scope instead of failing silently. Agents that only ever address channels by ID don't need the read scopes — the resolver fast-paths `C…` / `G…` / `D…` / `U…` inputs without any API call, so existing setups keep working unchanged.
  - @render-harness/registry@0.4.1

## 0.4.1

### Patch Changes

- cap-slack: stop tool calls hanging for ~30 minutes when Slack rate-limits or returns transient errors.

  The underlying `@slack/web-api` WebClient defaults to no per-request timeout and to `tenRetriesInAboutThirtyMinutes`, which silently retries 5xx and 429 responses for up to 30 minutes per call. From the agent's perspective the tool call appears stuck in-flight forever with no progress signal. `slack.send_message` is especially exposed — `chat.postMessage` is rate-limited to ~1 msg/sec/channel and trips a 429 + Retry-After whenever the agent posts a short burst.

  The pack now constructs the WebClient with `timeout: 15_000` and `retryConfig: { retries: 3, factor: 2, minTimeout: 500, maxTimeout: 3_000 }`, so a failing call surfaces as a clear tool error within ~70 seconds worst case (4 attempts × 15s + ~3.5s of backoff) instead of hanging. All other behavior is unchanged.

  No agent code changes required — the new defaults apply automatically on redeploy.

## 0.4.0

### Minor Changes

- cap-slack: stop surfacing raw Slack user and channel IDs to agents.
  - `slack.get_thread` and `slack.get_channel_history` now auto-resolve user IDs and the queried channel ID, attach `user_display_name` per message, rewrite `<@U…>` and `<#C…|name>` references in `text_resolved`, and return `resolved_users` / `resolved_channel` maps in the response.
  - Adds two new read tools: `slack.get_user_info` and `slack.get_channel_info` for on-demand lookups (for example to label IDs the agent sees in attachments, payload metadata, or operator-provided text).
  - Lookups share an in-memory cache scoped to the agent process so repeated calls stay cheap across turns.

  The new tools trigger a coordinated family-wide minor bump per AGENTS.md "Minor bumps must be coordinated across the whole family". The other listed packages are packaging-only bumps with no behavioral change.

  `@render-harness/web` also drops its `@render-harness/ui` peerDependency in this cut. Web has never imported the UI statically — it dynamic-imports `@render-harness/ui` inside `wrapWithUiSessionIfAvailable` / `mountUiIfAvailable` with a guarded fallback. The peer declaration was advisory only, and it was the sole reason Changesets cascaded `web` to a MAJOR bump during every coordinated minor cut (see commit `420c904`'s manual workaround). Consumers that want the operator UI install `@render-harness/ui` explicitly alongside `@render-harness/web` exactly as before; the scaffolder already adds it as a regular dependency when `ui` is selected, so no scaffold changes are required.

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.4.0

    0.3.0##

### Minor Changes

- Coordinated 0.3.0 baseline cut across the entire first-party harness family.
  See AGENTS.md § "Minor bumps must be coordinated across the whole family".

## 0.2.6

### Patch Changes

- Updated dependencies [70ab0f4]
  - @render-harness/registry@0.2.4

## 0.2.5

### Patch Changes

- @render-harness/registry@0.2.3

## 0.2.4

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.2.2

## 0.2.3

### Patch Changes

- Expose each package's `./package.json` through its `exports` map. Without this, modern Node's exports-based resolution rejects `require("@render-harness/<name>/package.json")`, which is exactly the lookup `@render-harness/registry`'s `readPackageVersion` uses to detect running harness versions for the operator UI. The operator UI was showing "Harness version is unknown — No running @render-harness package versions could be detected" for every consumer of the published packages.
- Updated dependencies
  - @render-harness/registry@0.2.1

## 0.2.2

### Patch Changes

- 24b0971: Allow connector packs to boot without provider API tokens by skipping local tools until env vars are configured.

## 0.2.1

### Patch Changes

- Read capability pack metadata versions from package.json so runtime pack metadata matches the published npm version.

## 0.2.0

### Minor Changes

- 6952832: Add connector-based capability installation, capability catalog metadata, harness version reporting, and first-party GitHub, Linear, Slack, and generic webhook capability packs.

### Patch Changes

- Updated dependencies [6952832]
  - @render-harness/registry@0.2.0
