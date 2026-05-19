/**
 * @render-harness/cap-notion
 *
 * Notion capability pack via the harness's per-end-user OAuth
 * connections API. Each end user clicks "Connect Notion" in the
 * operator UI; the pack stores their access token encrypted and tools
 * fetch it at call time via `secrets.requireConnection("notion")`.
 *
 * Notion's public-integration OAuth flow returns long-lived access
 * tokens with no refresh token, so this pack relies on the
 * `refreshTokenOptional: true` field on `OAuthProviderConfig`
 * (added in `@render-harness/core@0.6.1`). Refresh-on-use is a no-op;
 * if Notion 401s on a tool call, the pack returns an actionable error
 * asking the user to reconnect.
 *
 * Tools shipped (8 in read_write mode, 3 in read mode):
 *
 *   Search (always-on):
 *     - notion.search                  — workspace search by title
 *   Pages (always-on read):
 *     - notion.read_page               — metadata + flattened block tree
 *   Pages (read_write):
 *     - notion.create_page             — under a parent page OR database
 *     - notion.append_blocks           — add content to an existing page
 *     - notion.update_page_properties  — patch properties / archive
 *   Databases (always-on read):
 *     - notion.query_database          — Notion filter passthrough
 *   Databases (read_write):
 *     - notion.create_database_row     — insert into a database
 *     - notion.update_database_row     — patch row properties
 *
 * Config (pass under `capabilities[].config` in render-harness.yaml):
 *
 *   accessMode:      "read" | "read_write" (default: "read_write")
 *   clientIdEnv:     env var holding NOTION_OAUTH_CLIENT_ID (override)
 *   clientSecretEnv: env var holding NOTION_OAUTH_CLIENT_SECRET (override)
 *
 * Deployment requirements:
 *
 *   - Create a Notion public integration at https://www.notion.so/profile/integrations
 *     and copy its OAuth client id + secret.
 *   - Add the redirect URI `{RENDER_EXTERNAL_URL}/connections/notion/callback`
 *     to the integration's OAuth configuration.
 *   - Set `NOTION_OAUTH_CLIENT_ID` and `NOTION_OAUTH_CLIENT_SECRET` on
 *     the harness service.
 *   - Set `CONNECTIONS_ENCRYPTION_KEY` (already required by the
 *     connections API).
 *   - End users granting access also need to share each page/database
 *     they want the integration to see via Notion's "Add connections"
 *     menu — Notion's per-resource access model is workspace-wide
 *     OAuth + per-resource explicit share.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalToolHandler, OAuthProviderConfig, SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };
import { NOTION_PROVIDER_ID, type NotionAccessMode, notionProvider } from "./oauth.js";
import { databaseTools } from "./tools/databases.js";
import { pageTools } from "./tools/pages.js";
import { searchTool } from "./tools/search.js";

export type { NotionAccessMode } from "./oauth.js";
export { NOTION_PROVIDER_ID, notionProvider } from "./oauth.js";

interface NotionConfig {
  accessMode?: NotionAccessMode;
  clientIdEnv?: string;
  clientSecretEnv?: string;
}

const DEFAULT_CLIENT_ID_ENV = "NOTION_OAUTH_CLIENT_ID";
const DEFAULT_CLIENT_SECRET_ENV = "NOTION_OAUTH_CLIENT_SECRET";

function readConfig(raw: Record<string, unknown>): Required<NotionConfig> {
  const accessMode: NotionAccessMode = raw.accessMode === "read" ? "read" : "read_write";
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

const pack = definePack({
  name: "cap-notion",
  version: pkg.version,
  envSchema: [
    {
      name: DEFAULT_CLIENT_ID_ENV,
      required: true,
      secret: false,
      description: "Notion public integration OAuth client id.",
    },
    {
      name: DEFAULT_CLIENT_SECRET_ENV,
      required: true,
      secret: true,
      description: "Notion public integration OAuth client secret.",
    },
    {
      name: "CONNECTIONS_ENCRYPTION_KEY",
      required: true,
      secret: true,
      description:
        "32-byte base64 secret used by the harness to encrypt access tokens at rest. Generate with `openssl rand -base64 32`.",
    },
  ],
  connectionsRequired: [{ provider: NOTION_PROVIDER_ID, scopes: [] }],
  oauthProviders(ctx: PackContext): OAuthProviderConfig[] {
    const cfg = readConfig(ctx.config);
    return [
      notionProvider({
        ...(cfg.clientIdEnv ? { clientIdEnv: cfg.clientIdEnv } : {}),
        ...(cfg.clientSecretEnv ? { clientSecretEnv: cfg.clientSecretEnv } : {}),
      }),
    ];
  },
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    return [
      searchTool(),
      ...pageTools({ accessMode: cfg.accessMode }),
      ...databaseTools({ accessMode: cfg.accessMode }),
    ];
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
    return [
      {
        name: "notion-pages",
        description: "Search, read, create, and update Notion pages via cap-notion.",
        whenToUse:
          "When the user mentions a Notion page (by name or URL) or asks you to write something into Notion. Pair with notion-databases when the target is a database row.",
        contentPath: join(SKILLS_DIR, "notion-pages.md"),
      },
      {
        name: "notion-databases",
        description: "Query, create, and update rows in Notion databases via cap-notion.",
        whenToUse:
          "When the user wants to read or write structured records (tasks, contacts, project trackers) backed by a Notion database.",
        contentPath: join(SKILLS_DIR, "notion-databases.md"),
      },
    ];
  },
});

export default pack;
