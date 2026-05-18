/**
 * @render-harness/cap-google
 *
 * Google Workspace (Gmail + Calendar) capability pack. Uses the
 * harness's per-end-user OAuth connection API: each user clicks
 * "Connect Google" in the operator UI, the harness stores their
 * refresh token encrypted, and tools call
 * `secrets.requireConnection("google")` at runtime to get a fresh
 * access token.
 *
 * Tools shipped:
 *
 *   Gmail  (always-on read):
 *     - gmail.search          — list messages by query
 *     - gmail.get_message     — full message + decoded body
 *   Gmail  (accessMode: "read_write"):
 *     - gmail.send            — send a message
 *     - gmail.modify_labels   — add/remove labels
 *
 *   Calendar (always-on read):
 *     - calendar.list_events
 *     - calendar.get_event
 *     - calendar.freebusy
 *   Calendar (accessMode: "read_write"):
 *     - calendar.create_event
 *     - calendar.update_event
 *     - calendar.delete_event
 *
 * Config (pass under `capabilities[].config` in render-harness.yaml):
 *
 *   accessMode:        "read" | "read_write" (default: "read_write")
 *   clientIdEnv:       env var holding GOOGLE_OAUTH_CLIENT_ID (override)
 *   clientSecretEnv:   env var holding GOOGLE_OAUTH_CLIENT_SECRET (override)
 *
 * Deployment requirements:
 *
 *   - The harness service must run @render-harness/web ≥ the version
 *     that ships the connections API (CONNECTIONS_ENCRYPTION_KEY
 *     diagnostics + /connections routes).
 *   - Register an OAuth 2.0 client in Google Cloud Console with the
 *     authorized redirect URI:
 *       {RENDER_EXTERNAL_URL}/connections/google/callback
 *   - Set CONNECTIONS_ENCRYPTION_KEY (32 random bytes, base64) on the
 *     harness service.
 *   - Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on the
 *     harness service.
 */

import type { LocalToolHandler, OAuthProviderConfig } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };
import { GOOGLE_PROVIDER_ID, type GoogleAccessMode, googleProvider } from "./oauth.js";
import { calendarTools } from "./tools/calendar.js";
import { gmailTools } from "./tools/gmail.js";

export type { GoogleAccessMode } from "./oauth.js";
export { GOOGLE_PROVIDER_ID, googleProvider } from "./oauth.js";

interface GoogleConfig {
  accessMode?: GoogleAccessMode;
  clientIdEnv?: string;
  clientSecretEnv?: string;
}

const DEFAULT_CLIENT_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID";
const DEFAULT_CLIENT_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";

const pack = definePack({
  name: "cap-google",
  version: pkg.version,
  envSchema: [
    {
      name: DEFAULT_CLIENT_ID_ENV,
      required: true,
      secret: false,
      description: "Google Cloud OAuth 2.0 client id (Web application credentials).",
    },
    {
      name: DEFAULT_CLIENT_SECRET_ENV,
      required: true,
      secret: true,
      description: "Google Cloud OAuth 2.0 client secret.",
    },
    {
      name: "CONNECTIONS_ENCRYPTION_KEY",
      required: true,
      secret: true,
      description:
        "32-byte base64 secret used by the harness to encrypt refresh tokens at rest. Generate with `openssl rand -base64 32`.",
    },
  ],
  connectionsRequired: [
    {
      provider: GOOGLE_PROVIDER_ID,
      scopes: ["gmail.modify", "gmail.send", "calendar", "userinfo.email"],
    },
  ],
  oauthProviders(ctx: PackContext): OAuthProviderConfig[] {
    const cfg = readConfig(ctx.config);
    return [
      googleProvider({
        ...(cfg.clientIdEnv ? { clientIdEnv: cfg.clientIdEnv } : {}),
        ...(cfg.clientSecretEnv ? { clientSecretEnv: cfg.clientSecretEnv } : {}),
        ...(cfg.accessMode ? { accessMode: cfg.accessMode } : {}),
      }),
    ];
  },
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    const accessMode = cfg.accessMode ?? "read_write";
    return [...gmailTools({ accessMode }), ...calendarTools({ accessMode })];
  },
});

export default pack;

function readConfig(raw: Record<string, unknown>): Required<GoogleConfig> {
  const accessMode = raw.accessMode === "read" ? "read" : "read_write";
  const clientIdEnv =
    typeof raw.clientIdEnv === "string" && raw.clientIdEnv.length > 0
      ? raw.clientIdEnv
      : DEFAULT_CLIENT_ID_ENV;
  const clientSecretEnv =
    typeof raw.clientSecretEnv === "string" && raw.clientSecretEnv.length > 0
      ? raw.clientSecretEnv
      : DEFAULT_CLIENT_SECRET_ENV;
  return { accessMode, clientIdEnv, clientSecretEnv };
}
