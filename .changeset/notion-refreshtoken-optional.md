---
"@render-harness/core": patch
"@render-harness/web": patch
---

**NEW OPT-IN: `refreshTokenOptional` on `OAuthProviderConfig`.**

Default behavior is unchanged — existing providers (Google, Microsoft, Slack, etc.) still throw when the token endpoint omits a `refresh_token`, which is the right move because the omission is almost always a misconfigured scope.

Set `refreshTokenOptional: true` for providers that issue long-lived access tokens with no refresh token by design — Notion's default public-integration flow is the canonical case (the [Notion docs](https://developers.notion.com/docs/authorization) explicitly call out no refresh tokens on standard public OAuth). Stripe Connect's standard-account flow and a handful of legacy SaaS APIs have the same shape.

When the flag is set:

- `exchangeAuthorizationCode` no longer rejects the (refreshless) token response.
- The web callback route stores an empty-string sentinel in the `refreshToken` column and anchors `expires_at` 100 years in the future when the provider doesn't return `expires_in`.
- `SecretsContext.requireConnection` refresh-on-use becomes a no-op for that provider — the stored access token is returned unchanged. Pack tools handle the eventual 401 (token revoked by the user, etc.) themselves with a clear "ask the user to reconnect at /ui/connections" message.

This unblocks `@render-harness/cap-notion` (shipping at `0.6.0` in this release) and any future packs for refresh-token-less providers. Existing OAuth packs (cap-google) are unaffected — the flag is opt-in.
