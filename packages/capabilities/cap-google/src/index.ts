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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalToolHandler, OAuthProviderConfig, SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };
import {
  assembleGoogleScopes,
  DEFAULT_SURFACES,
  GOOGLE_PROVIDER_ID,
  type GoogleAccessMode,
  type GoogleSurface,
  googleProvider,
} from "./oauth.js";
import { calendarTools } from "./tools/calendar.js";
import { docsTools } from "./tools/docs.js";
import { driveTools } from "./tools/drive.js";
import { gmailTools } from "./tools/gmail.js";
import { sheetsTools } from "./tools/sheets.js";

export type { GoogleAccessMode, GoogleSurface } from "./oauth.js";
export {
  assembleGoogleScopes,
  DEFAULT_SURFACES,
  GOOGLE_PROVIDER_ID,
  googleProvider,
} from "./oauth.js";

interface ResolvedGoogleConfig {
  accessMode: GoogleAccessMode;
  surfaces: GoogleSurface[];
  clientIdEnv: string;
  clientSecretEnv: string;
}

const DEFAULT_CLIENT_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID";
const DEFAULT_CLIENT_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";
const VALID_SURFACES: GoogleSurface[] = ["gmail", "calendar", "drive", "docs", "sheets"];

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
      // Required scopes here reflect the default (gmail + calendar)
      // surface set. When operators opt into drive/docs/sheets via
      // surfaces, the OAuth flow requests the extra scopes — but the
      // connectionsRequired hint stays minimal so the operator UI
      // doesn't show stale "missing scope" warnings for surfaces the
      // pack isn't using.
      scopes: ["gmail.modify", "gmail.send", "calendar", "userinfo.email"],
    },
  ],
  oauthProviders(ctx: PackContext): OAuthProviderConfig[] {
    const cfg = readConfig(ctx.config);
    return [
      googleProvider({
        clientIdEnv: cfg.clientIdEnv,
        clientSecretEnv: cfg.clientSecretEnv,
        accessMode: cfg.accessMode,
        surfaces: cfg.surfaces,
      }),
    ];
  },
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    const tools: LocalToolHandler[] = [];
    if (cfg.surfaces.includes("gmail")) tools.push(...gmailTools({ accessMode: cfg.accessMode }));
    if (cfg.surfaces.includes("calendar"))
      tools.push(...calendarTools({ accessMode: cfg.accessMode }));
    if (cfg.surfaces.includes("drive")) tools.push(...driveTools({ accessMode: cfg.accessMode }));
    if (cfg.surfaces.includes("docs")) tools.push(...docsTools({ accessMode: cfg.accessMode }));
    if (cfg.surfaces.includes("sheets")) tools.push(...sheetsTools({ accessMode: cfg.accessMode }));
    return tools;
  },
  skills(ctx: PackContext): SkillMetadata[] {
    const cfg = readConfig(ctx.config);
    const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
    const out: SkillMetadata[] = [];
    if (cfg.surfaces.includes("drive")) {
      out.push({
        name: "google-drive",
        description: "List, search, read, and upload files in the user's Google Drive.",
        whenToUse:
          "When the user references a Drive file (by name or URL), asks you to summarize a document, or wants you to drop a result file in Drive.",
        contentPath: join(SKILLS_DIR, "google-drive.md"),
      });
    }
    if (cfg.surfaces.includes("docs")) {
      out.push({
        name: "google-docs",
        description: "Read, create, and append text to Google Docs.",
        whenToUse:
          "When the user references a Google Doc, asks you to draft something into a doc, or wants you to add a paragraph to an existing doc.",
        contentPath: join(SKILLS_DIR, "google-docs.md"),
      });
    }
    if (cfg.surfaces.includes("sheets")) {
      out.push({
        name: "google-sheets",
        description: "Read ranges, append rows, update cells, and create Google Sheets.",
        whenToUse:
          "When the user references a Google Sheet, asks you to pull tabular data, or wants you to record results in a sheet.",
        contentPath: join(SKILLS_DIR, "google-sheets.md"),
      });
    }
    return out;
  },
});

export default pack;

function readConfig(raw: Record<string, unknown>): ResolvedGoogleConfig {
  const accessMode: GoogleAccessMode = raw.accessMode === "read" ? "read" : "read_write";
  const clientIdEnv =
    typeof raw.clientIdEnv === "string" && raw.clientIdEnv.length > 0
      ? raw.clientIdEnv
      : DEFAULT_CLIENT_ID_ENV;
  const clientSecretEnv =
    typeof raw.clientSecretEnv === "string" && raw.clientSecretEnv.length > 0
      ? raw.clientSecretEnv
      : DEFAULT_CLIENT_SECRET_ENV;
  const surfaces = parseSurfaces(raw.surfaces);
  return { accessMode, surfaces, clientIdEnv, clientSecretEnv };
}

function parseSurfaces(raw: unknown): GoogleSurface[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SURFACES];
  const filtered = raw.filter(
    (s): s is GoogleSurface => typeof s === "string" && (VALID_SURFACES as string[]).includes(s),
  );
  if (filtered.length === 0) return [...DEFAULT_SURFACES];
  // Dedup while preserving order.
  return [...new Set(filtered)];
}

// Re-export for callers that want to introspect the assembled scope
// set (e.g. ops tooling, scope-drift detectors).
export { assembleGoogleScopes as resolveGoogleScopes };
