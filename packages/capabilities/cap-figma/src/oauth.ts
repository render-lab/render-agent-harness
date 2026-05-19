/**
 * Figma OAuth provider config for the harness's connections API.
 *
 * Figma's developer platform requires **granular per-action OAuth
 * scopes** as of the November 2025 platform update — the previous
 * coarse `files:read` / `file_read` scopes were deprecated and apps
 * that still use them stop working. This pack ships only the new
 * granular scope strings.
 *
 * Reference: https://developers.figma.com/docs/rest-api/scopes/
 *
 * `accessMode` config picks the scope bundle:
 *
 *   - "read"                 → file_content:read, file_metadata:read,
 *                              file_comments:read, current_user:read
 *   - "read_write_comments"  → adds file_comments:write (default)
 *
 * Why no broader write scope: cap-figma v1 only writes comments
 * (Figma's REST API exposes comment write but not file-content
 * write — file edits go through the Plugin API instead). Adding
 * a separate `read_write_files` mode here would request scopes the
 * pack can't even use, which Figma's app review would flag.
 *
 * App-review note (also from Nov 2025): public OAuth apps require
 * Figma's app-review approval before non-development users can
 * connect. Private/internal apps skip review — recommend that path
 * for single-org deployments. The README spells this out.
 */

import type { OAuthProviderConfig } from "@render-harness/core";

export type FigmaAccessMode = "read" | "read_write_comments";

const READ_SCOPES = [
  "file_content:read",
  "file_metadata:read",
  "file_comments:read",
  "current_user:read",
];

const WRITE_COMMENTS_SCOPES = [...READ_SCOPES, "file_comments:write"];

export const FIGMA_PROVIDER_ID = "figma";

export function assembleFigmaScopes(accessMode: FigmaAccessMode): string[] {
  return accessMode === "read_write_comments" ? [...WRITE_COMMENTS_SCOPES] : [...READ_SCOPES];
}

export function figmaProvider(
  args: { clientIdEnv?: string; clientSecretEnv?: string; accessMode?: FigmaAccessMode } = {},
): OAuthProviderConfig {
  const accessMode = args.accessMode ?? "read_write_comments";
  return {
    id: FIGMA_PROVIDER_ID,
    displayName: "Figma",
    authorizeUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    clientIdEnv: args.clientIdEnv ?? "FIGMA_OAUTH_CLIENT_ID",
    clientSecretEnv: args.clientSecretEnv ?? "FIGMA_OAUTH_CLIENT_SECRET",
    defaultScopes: assembleFigmaScopes(accessMode),
    fetchAccountLabel: async (accessToken) => {
      try {
        const res = await fetch("https://api.figma.com/v1/me", {
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
          },
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as {
          email?: unknown;
          handle?: unknown;
        };
        if (typeof body.email === "string") return body.email;
        if (typeof body.handle === "string") return body.handle;
        return undefined;
      } catch {
        return undefined;
      }
    },
  };
}
