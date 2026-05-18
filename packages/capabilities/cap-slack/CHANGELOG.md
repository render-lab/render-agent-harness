# @render-harness/cap-slack

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
