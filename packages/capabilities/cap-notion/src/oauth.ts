/**
 * Notion OAuth provider config for the harness's connections API.
 *
 * Notion's public-integration OAuth issues long-lived access tokens
 * with no refresh token. We set `refreshTokenOptional: true` so
 * `exchangeAuthorizationCode` doesn't reject the (refreshless)
 * response, and refresh-on-use becomes a no-op — the stored access
 * token is returned unchanged from `secrets.requireConnection("notion")`
 * until the operator reconnects.
 *
 * Notion's `/v1/users/me` requires the `Notion-Version` header, so
 * `fetchAccountLabel` sends it. The endpoint returns
 * `{ bot: { workspace_name }, name, ... }` for an integration bot, so
 * we use `workspace_name` for the Connections-tab label.
 */

import type { OAuthProviderConfig } from "@render-harness/core";
import { NOTION_API_BASE, NOTION_API_VERSION } from "./lib.js";

export type NotionAccessMode = "read" | "read_write";

export const NOTION_PROVIDER_ID = "notion";

export function notionProvider(
  args: { clientIdEnv?: string; clientSecretEnv?: string } = {},
): OAuthProviderConfig {
  return {
    id: NOTION_PROVIDER_ID,
    displayName: "Notion",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    clientIdEnv: args.clientIdEnv ?? "NOTION_OAUTH_CLIENT_ID",
    clientSecretEnv: args.clientSecretEnv ?? "NOTION_OAUTH_CLIENT_SECRET",
    // Notion grants are workspace-wide; the integration's installed
    // scopes are configured server-side at integration-setup time, not
    // requested per-OAuth-handshake. Leaving this empty results in
    // `scope=` (empty) which Notion accepts.
    defaultScopes: [],
    extraAuthorizeParams: {
      owner: "user",
    },
    refreshTokenOptional: true,
    fetchAccountLabel: async (accessToken) => {
      const res = await fetch(`${NOTION_API_BASE}/users/me`, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "notion-version": NOTION_API_VERSION,
        },
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        bot?: { workspace_name?: unknown };
        name?: unknown;
      };
      if (typeof body.bot?.workspace_name === "string") return body.bot.workspace_name;
      if (typeof body.name === "string") return body.name;
      return undefined;
    },
  };
}
