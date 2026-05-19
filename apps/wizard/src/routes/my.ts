/**
 *  - GET /api/my/harnesses — list managed repos belonging to the
 *    authenticated user.
 *  - GET /api/harnesses/claim — verify an HMAC-signed claim token,
 *    require login, add the user as a collaborator + insert
 *    `wizard_user_repos`. Used for:
 *      (a) anonymous-scaffold orphans (success screen embeds a claim URL),
 *      (b) CLI-scaffolded harnesses connecting back to the wizard.
 *
 * The claim token is the same HMAC shape used for OAuth state +
 * install-flow state — see `auth.ts` and `installs.ts`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { readSessionCookie } from "../auth.js";
import { createOctokit, type GithubAppCreds } from "../github-app.js";
import type { WizardStore } from "../store.js";
import type { ErrorResponse } from "../types.js";

export interface ClaimTokenClaims {
  org: string;
  repo: string;
  installationId: string;
  agentSlug: string;
  exp: number;
  nonce: string;
}

export interface RegisterMyRouteOpts {
  store: WizardStore;
  sessionSecret: string | null;
  /** Same secret used to sign install-flow state and claim tokens. */
  claimSecret: string | null;
  github: Omit<GithubAppCreds, "installationId"> | null;
  /** Public origin of the wizard, used in the post-claim redirect. */
  publicUrl: string;
  deps?: {
    createOctokit?: typeof createOctokit;
  };
}

export function registerMyRoutes(app: Hono, opts: RegisterMyRouteOpts): void {
  const createOctokitFn = opts.deps?.createOctokit ?? createOctokit;

  app.get("/api/my/harnesses", async (c) => {
    if (!opts.sessionSecret) {
      return c.json<ErrorResponse>({ error: "session_secret_not_configured" }, 503);
    }
    const claims = readSessionCookie(c, opts.sessionSecret);
    if (!claims) return c.json<ErrorResponse>({ error: "unauthenticated" }, 401);
    const repos = await opts.store.listReposForUser(claims.githubUserId);
    return c.json({ harnesses: repos });
  });

  app.get("/api/harnesses/claim", async (c) => {
    if (!opts.sessionSecret || !opts.claimSecret) {
      return c.json<ErrorResponse>({ error: "session_secret_not_configured" }, 503);
    }
    if (!opts.github) return c.json<ErrorResponse>({ error: "github_not_configured" }, 503);
    const session = readSessionCookie(c, opts.sessionSecret);
    if (!session) {
      // Send the user through login first; they'll come back to this URL.
      const back = `/api/harnesses/claim?token=${encodeURIComponent(c.req.query("token") ?? "")}`;
      return c.redirect(`/api/auth/login?next=${encodeURIComponent(back)}`, 302);
    }
    const token = c.req.query("token") ?? "";
    let claim: ClaimTokenClaims;
    try {
      claim = verifyClaimToken(opts.claimSecret, token);
    } catch (err) {
      return c.json<ErrorResponse>(
        { error: "invalid_claim_token", details: err instanceof Error ? err.message : String(err) },
        400,
      );
    }

    const user = await opts.store.getUser(session.githubUserId);
    if (!user) return c.json<ErrorResponse>({ error: "unauthenticated" }, 401);

    try {
      const octokit = await createOctokitFn({
        creds: { ...opts.github, installationId: claim.installationId },
      });
      await octokit.repos.addCollaborator({
        owner: claim.org,
        repo: claim.repo,
        username: user.login,
        permission: "push",
      });
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "github_collaborator_add_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    await opts.store.addUserRepo({
      githubUserId: user.githubUserId,
      org: claim.org,
      repo: claim.repo,
      installationId: claim.installationId,
      agentSlug: claim.agentSlug,
      role: "owner",
    });

    return c.redirect("/my", 302);
  });
}

// ---------------------------------------------------------------------
// Claim token sign / verify (shared with scaffold route)
// ---------------------------------------------------------------------

const CLAIM_LIFETIME_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function signClaimToken(
  secret: string,
  claims: Omit<ClaimTokenClaims, "exp" | "nonce">,
): string {
  const full: ClaimTokenClaims = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + CLAIM_LIFETIME_SECONDS,
    nonce: randomHex(8),
  };
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(full), "utf8"));
  const sig = base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyClaimToken(secret: string, token: string): ClaimTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("malformed token");
  const [payload, providedSig] = parts as [string, string];
  const expectedSig = base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
  const aBuf = Buffer.from(providedSig);
  const bBuf = Buffer.from(expectedSig);
  if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) {
    throw new Error("signature mismatch");
  }
  const claims = JSON.parse(
    Buffer.from(base64UrlDecode(payload)).toString("utf8"),
  ) as ClaimTokenClaims;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("expired");
  }
  if (
    typeof claims.org !== "string" ||
    typeof claims.repo !== "string" ||
    typeof claims.installationId !== "string"
  ) {
    throw new Error("missing claims");
  }
  return claims;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}
