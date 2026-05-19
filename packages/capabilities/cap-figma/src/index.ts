/**
 * @render-harness/cap-figma
 *
 * Figma capability pack via the harness's per-end-user OAuth
 * connections API. **First pack with granular per-action OAuth
 * scopes** (post-Nov-2025 Figma platform update) — validates the
 * granular-scope pattern that cap-atlassian / cap-hubspot /
 * cap-salesforce will reuse, on a relatively small surface (~7
 * tools across files + comments).
 *
 * Tools shipped (7 in read_write_comments, 6 in read):
 *
 *   Files (read):
 *     - figma.read_file              (depth-2 default; ids: [...] for targeted)
 *     - figma.read_file_nodes        full subtree for specific node ids
 *     - figma.read_file_metadata     name, last_modified, role, thumbnail
 *   Projects / teams (read):
 *     - figma.list_team_projects
 *     - figma.list_project_files
 *   Comments (read always; write opt-in via accessMode):
 *     - figma.read_comments
 *     - figma.post_comment           (read_write_comments only)
 *
 * Config (pass under `capabilities[].config` in render-harness.yaml):
 *
 *   accessMode:      "read" | "read_write_comments"  (default "read_write_comments")
 *   clientIdEnv:     env var holding FIGMA_OAUTH_CLIENT_ID (override)
 *   clientSecretEnv: env var holding FIGMA_OAUTH_CLIENT_SECRET (override)
 *
 * Deployment requirements:
 *
 *   - Create a Figma OAuth app at https://www.figma.com/developers/apps
 *   - Add the redirect URL `{RENDER_EXTERNAL_URL}/connections/figma/callback`
 *   - For public OAuth apps, Figma requires app-review approval before
 *     non-development users can connect. **Recommend private/internal
 *     app type for single-org deployments** — skips review entirely.
 *     This is the most common cap-figma deployment shape.
 *   - Set FIGMA_OAUTH_CLIENT_ID / FIGMA_OAUTH_CLIENT_SECRET on the
 *     harness service.
 *   - Set CONNECTIONS_ENCRYPTION_KEY (already required).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalToolHandler, OAuthProviderConfig, SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };
import { FIGMA_PROVIDER_ID, type FigmaAccessMode, figmaProvider } from "./oauth.js";
import { figmaTools } from "./tools.js";

export type { FigmaAccessMode } from "./oauth.js";
export { assembleFigmaScopes, FIGMA_PROVIDER_ID, figmaProvider } from "./oauth.js";

interface ResolvedFigmaConfig {
  accessMode: FigmaAccessMode;
  clientIdEnv: string;
  clientSecretEnv: string;
}

const DEFAULT_CLIENT_ID_ENV = "FIGMA_OAUTH_CLIENT_ID";
const DEFAULT_CLIENT_SECRET_ENV = "FIGMA_OAUTH_CLIENT_SECRET";

const pack = definePack({
  name: "cap-figma",
  version: pkg.version,
  envSchema: [
    {
      name: DEFAULT_CLIENT_ID_ENV,
      required: true,
      secret: false,
      description: "Figma OAuth app client id (from https://www.figma.com/developers/apps).",
    },
    {
      name: DEFAULT_CLIENT_SECRET_ENV,
      required: true,
      secret: true,
      description: "Figma OAuth app client secret.",
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
      provider: FIGMA_PROVIDER_ID,
      // Hint to the operator UI — these are the read scopes the pack
      // always needs. The actual scope set requested at OAuth time
      // also includes file_comments:write when accessMode is
      // read_write_comments.
      scopes: ["file_content:read", "file_metadata:read", "file_comments:read"],
    },
  ],
  oauthProviders(ctx: PackContext): OAuthProviderConfig[] {
    const cfg = readConfig(ctx.config);
    return [
      figmaProvider({
        clientIdEnv: cfg.clientIdEnv,
        clientSecretEnv: cfg.clientSecretEnv,
        accessMode: cfg.accessMode,
      }),
    ];
  },
  localTools(ctx: PackContext): LocalToolHandler[] {
    const cfg = readConfig(ctx.config);
    return figmaTools({ accessMode: cfg.accessMode });
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
    return [
      {
        name: "figma-files",
        description:
          "Read Figma files — file structure (pages → frames → nodes), node id encoding, when to use read_file vs read_file_nodes.",
        whenToUse:
          "When the user references a Figma file (by URL or name) or asks you to inspect / summarize design content.",
        contentPath: join(SKILLS_DIR, "figma-files.md"),
      },
      {
        name: "figma-comments",
        description: "Read and post comments on Figma files (replies, pin coordinates).",
        whenToUse:
          "When the user asks you to leave feedback on a design, reply to a comment thread, or summarize comments on a file.",
        contentPath: join(SKILLS_DIR, "figma-comments.md"),
      },
    ];
  },
});

export default pack;

function readConfig(raw: Record<string, unknown>): ResolvedFigmaConfig {
  const accessMode: FigmaAccessMode = raw.accessMode === "read" ? "read" : "read_write_comments";
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
