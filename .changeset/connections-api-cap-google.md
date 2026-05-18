---
"@render-harness/core": minor
"@render-harness/contracts": minor
"@render-harness/registry": minor
"@render-harness/runtime-cron": minor
"@render-harness/runtime-web": minor
"@render-harness/runtime-worker": minor
"@render-harness/runtime-workflows": minor
"@render-harness/ui": minor
"@render-harness/web": minor
"@render-harness/wizard": minor
"@render-harness/cap-browser-browserbase": minor
"@render-harness/cap-filesystem": minor
"@render-harness/cap-github": minor
"@render-harness/cap-google": minor
"@render-harness/cap-linear": minor
"@render-harness/cap-memory-pg": minor
"@render-harness/cap-scrape-firecrawl": minor
"@render-harness/cap-search-exa": minor
"@render-harness/cap-search-tavily": minor
"@render-harness/cap-slack": minor
"@render-harness/cap-webhook-generic": minor
"create-render-agent": minor
---

Per-end-user OAuth connection API + `cap-google` (Gmail + Calendar).

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
