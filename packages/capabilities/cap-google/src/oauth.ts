/**
 * Google OAuth provider config for the harness's connections API.
 *
 * Scopes are assembled per (accessMode, surfaces). Default is gmail +
 * calendar in `read_write` mode, matching pre-0.6.1 behaviour exactly
 * — existing users see no change unless they opt into `surfaces:` with
 * drive, docs, or sheets.
 *
 *   - gmail.modify   : list, read, modify labels, send (covers gmail.send too)
 *   - gmail.send     : separate scope Google requires for `users.messages.send`
 *   - calendar       : full calendar R/W
 *   - drive.file     : Drive files the agent created or the user explicitly shared
 *                      (least-privilege; preferred default for accessMode: read_write)
 *   - drive.readonly : broader read access; opt in via accessMode: read + surfaces: [drive]
 *   - documents      : Google Docs R/W
 *   - spreadsheets   : Google Sheets R/W
 *   - userinfo.email : powers the "Connected as foo@example.com" UI affordance
 *
 * `access_type=offline` + `prompt=consent` is REQUIRED for Google to
 * return a refresh_token (it omits it on subsequent connects otherwise),
 * so the harness's exchangeAuthorizationCode helper would throw "did
 * not return a refresh_token".
 *
 * The "read" access mode narrows the scope set to read-only variants
 * so users who don't want the agent sending email or modifying calendar
 * entries can consent to a smaller scope set. In `read` mode, opting
 * into `surfaces: [drive]` uses `drive.readonly` (broader read) instead
 * of `drive.file`; opting into `surfaces: [docs]` or `[sheets]` uses
 * the corresponding `.readonly` variants.
 *
 * **Switching surfaces after a user has already connected** invalidates
 * the existing scope grant: Google's incremental authorization +
 * `prompt=consent` re-shows the consent screen, but the user has to
 * disconnect and reconnect at /ui/connections. The pack's tool errors
 * detect the scope drift and surface an actionable hint.
 */

import type { OAuthProviderConfig } from "@render-harness/core";

export type GoogleAccessMode = "read" | "read_write";

export type GoogleSurface = "gmail" | "calendar" | "drive" | "docs" | "sheets";

export const DEFAULT_SURFACES: GoogleSurface[] = ["gmail", "calendar"];

interface ScopeMatrixEntry {
  read: string[];
  write: string[];
}

/**
 * Source of truth for scope mapping. Each surface contributes its
 * read scopes always, plus write scopes when accessMode is read_write.
 * Scopes are deduped at assembly time.
 */
const SCOPE_MATRIX: Record<GoogleSurface, ScopeMatrixEntry> = {
  gmail: {
    read: ["https://www.googleapis.com/auth/gmail.readonly"],
    write: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  },
  calendar: {
    read: ["https://www.googleapis.com/auth/calendar.readonly"],
    write: ["https://www.googleapis.com/auth/calendar"],
  },
  drive: {
    // In read-only mode, agents probably want broad read access (browse
    // the user's whole Drive, summarize). In read_write mode, default
    // to `drive.file` for least-privilege — only files the agent
    // created or the user explicitly shared with the agent's OAuth app.
    read: ["https://www.googleapis.com/auth/drive.readonly"],
    write: ["https://www.googleapis.com/auth/drive.file"],
  },
  docs: {
    read: ["https://www.googleapis.com/auth/documents.readonly"],
    write: ["https://www.googleapis.com/auth/documents"],
  },
  sheets: {
    read: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    write: ["https://www.googleapis.com/auth/spreadsheets"],
  },
};

const USERINFO_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

/**
 * Assemble the OAuth scope list for a given (accessMode, surfaces)
 * combination.
 *
 * Google's scope hierarchy is "write implies read" for every surface
 * we care about — `gmail.modify` covers `gmail.readonly`, `calendar`
 * covers `calendar.readonly`, etc. So `read_write` mode requests
 * ONLY the write scope per surface (which Google's consent screen
 * presents as the broader permission); `read` mode requests the
 * `.readonly` variants explicitly. Including both would be redundant
 * and would inflate the consent screen with duplicated asks.
 */
export function assembleGoogleScopes(args: {
  accessMode: GoogleAccessMode;
  surfaces: GoogleSurface[];
}): string[] {
  const out = new Set<string>([USERINFO_SCOPE]);
  for (const surface of args.surfaces) {
    const entry = SCOPE_MATRIX[surface];
    if (!entry) continue;
    const scopes = args.accessMode === "read_write" ? entry.write : entry.read;
    for (const s of scopes) out.add(s);
  }
  return [...out];
}

export const GOOGLE_PROVIDER_ID = "google";

export function googleProvider(
  args: {
    clientIdEnv?: string;
    clientSecretEnv?: string;
    accessMode?: GoogleAccessMode;
    surfaces?: GoogleSurface[];
  } = {},
): OAuthProviderConfig {
  const accessMode = args.accessMode ?? "read_write";
  const surfaces = args.surfaces ?? DEFAULT_SURFACES;
  return {
    id: GOOGLE_PROVIDER_ID,
    displayName: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    clientIdEnv: args.clientIdEnv ?? "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnv: args.clientSecretEnv ?? "GOOGLE_OAUTH_CLIENT_SECRET",
    defaultScopes: assembleGoogleScopes({ accessMode, surfaces }),
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
