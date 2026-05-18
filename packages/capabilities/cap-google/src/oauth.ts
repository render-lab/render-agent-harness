/**
 * Google OAuth provider config for the harness's connections API.
 *
 * Scopes are chosen to support the Gmail + Calendar tools that ship in
 * this pack:
 *
 *   - gmail.modify  : list, read, modify labels, send (covers gmail.send too)
 *   - gmail.send    : separate scope Google requires for `users.messages.send`
 *   - calendar      : full calendar R/W
 *   - userinfo.email: lets us populate the "Connected as foo@example.com"
 *                     UI affordance
 *
 * `access_type=offline` + `prompt=consent` is REQUIRED for Google to
 * return a refresh_token (it omits it on subsequent connects otherwise),
 * so the harness's exchangeAuthorizationCode helper would throw "did
 * not return a refresh_token".
 *
 * The "read" access mode (configured via pack config) narrows the scope
 * set to the read-only variants so users who don't want the agent
 * sending email or modifying calendar entries can consent to a smaller
 * scope set.
 */

import type { OAuthProviderConfig } from "@render-harness/core";

export type GoogleAccessMode = "read" | "read_write";

const READ_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

const READ_WRITE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const GOOGLE_PROVIDER_ID = "google";

export function googleProvider(
  args: { clientIdEnv?: string; clientSecretEnv?: string; accessMode?: GoogleAccessMode } = {},
): OAuthProviderConfig {
  const accessMode = args.accessMode ?? "read_write";
  return {
    id: GOOGLE_PROVIDER_ID,
    displayName: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    clientIdEnv: args.clientIdEnv ?? "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnv: args.clientSecretEnv ?? "GOOGLE_OAUTH_CLIENT_SECRET",
    defaultScopes: accessMode === "read" ? READ_SCOPES : READ_WRITE_SCOPES,
    // Without `access_type=offline + prompt=consent`, Google withholds
    // the refresh_token on every connect after the first — and the
    // refresh_token is what the harness encrypts and uses for
    // refresh-on-use. `prompt=consent` also re-shows the consent screen
    // so scope expansion (e.g. adding Drive later) prompts the user
    // instead of silently failing.
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
    fetchAccountLabel: async (accessToken) => {
      const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { email?: unknown };
      return typeof body.email === "string" ? body.email : undefined;
    },
  };
}
