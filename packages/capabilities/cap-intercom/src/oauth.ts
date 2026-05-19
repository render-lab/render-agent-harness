/**
 * Intercom OAuth provider config for the harness's connections API.
 *
 * Intercom uses standard OAuth 2.0 Authorization Code with refresh
 * tokens (since 2021). The `fetchAccountLabel` hook pulls the
 * connected workspace name from `/me` so the Connections tab shows
 * "Connected as MyWorkspace" instead of the bare "intercom".
 *
 * Intercom scopes are configured server-side on the integration's
 * settings page rather than requested per-OAuth-handshake — sending
 * `scope=` is a no-op for Intercom. The `defaultScopes` list is
 * therefore empty.
 */

import type { OAuthProviderConfig } from "@render-harness/core";
import { INTERCOM_API_BASE, INTERCOM_API_VERSION } from "./lib.js";

export const INTERCOM_PROVIDER_ID = "intercom";

export function intercomProvider(
  args: { clientIdEnv?: string; clientSecretEnv?: string } = {},
): OAuthProviderConfig {
  return {
    id: INTERCOM_PROVIDER_ID,
    displayName: "Intercom",
    authorizeUrl: "https://app.intercom.com/oauth",
    tokenUrl: "https://api.intercom.io/auth/eagle/token",
    clientIdEnv: args.clientIdEnv ?? "INTERCOM_OAUTH_CLIENT_ID",
    clientSecretEnv: args.clientSecretEnv ?? "INTERCOM_OAUTH_CLIENT_SECRET",
    // Scopes are configured server-side on the Intercom app settings.
    defaultScopes: [],
    fetchAccountLabel: async (accessToken) => {
      try {
        const res = await fetch(`${INTERCOM_API_BASE}/me`, {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "intercom-version": INTERCOM_API_VERSION,
            accept: "application/json",
          },
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as {
          app?: { name?: unknown };
          name?: unknown;
          email?: unknown;
        };
        if (typeof body.app?.name === "string") return body.app.name;
        if (typeof body.name === "string") return body.name;
        if (typeof body.email === "string") return body.email;
        return undefined;
      } catch {
        return undefined;
      }
    },
  };
}
