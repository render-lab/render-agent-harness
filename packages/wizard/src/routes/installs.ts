/**
 * GitHub App installation flow for CLI-scaffolded agents. The user runs
 * `npx create-render-agent` locally, pushes the result to their own
 * GitHub repo, and deploys on Render. Their `.render-harness/agent.json`
 * starts with `installationId: null`. The operator UI's "Edit model"
 * button surfaces a 409 from the worker proxy and redirects the
 * browser here.
 *
 * Two endpoints:
 *
 *   - GET /api/installs/start — issues a signed state token carrying
 *     `{ agentSlug, next, exp, nonce }` and 302s to GitHub's App-
 *     install page with that state.
 *
 *   - GET /api/installs/callback — GitHub redirects here with the new
 *     installation_id + the same state. We verify the state, list the
 *     installation's accessible repos, find the one whose
 *     `.render-harness/agent.json` matches the state's agentSlug, and
 *     commit an updated agent.json carrying the installationId. Render
 *     auto-deploys on push so the operator can retry the edit and have
 *     it succeed.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { createOctokit, type GithubAppCreds } from "../github-app.js";
import type { ErrorResponse } from "../types.js";

const METADATA_PATH = ".render-harness/agent.json";
const STATE_LIFETIME_SECONDS = 15 * 60;

export interface RegisterInstallsRouteOpts {
  /** App identifier (slug as shown in the GitHub URL). Used to build the install URL. */
  appName: string | null;
  /** App-level credentials minus `installationId` — supplied per-request. */
  github: Omit<GithubAppCreds, "installationId"> | null;
  /**
   * Secret used to HMAC-sign the state token. Same value plumbed into
   * the operator UI's `UI_COOKIE_SECRET` env so callbacks across
   * services stay verifiable.
   */
  stateSecret: string | null;
  /** Public origin of the wizard, used to build the callback URL. */
  publicUrl: string;
  deps?: {
    createOctokit?: typeof createOctokit;
  };
}

interface InstallStateClaims {
  agentSlug: string;
  next: string;
  exp: number;
  nonce: string;
}

export function registerInstallsRoute(app: Hono, opts: RegisterInstallsRouteOpts): void {
  const createOctokitFn = opts.deps?.createOctokit ?? createOctokit;

  app.get("/api/installs/start", (c) => {
    if (!opts.appName) {
      return c.json<ErrorResponse>(
        { error: "app_name_not_configured", details: "set GITHUB_APP_NAME" },
        503,
      );
    }
    if (!opts.stateSecret) {
      return c.json<ErrorResponse>({ error: "state_secret_not_configured" }, 503);
    }
    const agentSlug = c.req.query("agentSlug");
    const next = c.req.query("next") ?? "/";
    if (!agentSlug || agentSlug.length === 0) {
      return c.json<ErrorResponse>(
        { error: "missing_agent_slug", details: "?agentSlug=<slug> is required" },
        400,
      );
    }
    const state = signState(opts.stateSecret, {
      agentSlug,
      next,
      exp: Math.floor(Date.now() / 1000) + STATE_LIFETIME_SECONDS,
      nonce: randomBytes(8).toString("hex"),
    });
    const url = new URL(
      `https://github.com/apps/${encodeURIComponent(opts.appName)}/installations/new`,
    );
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.get("/api/installs/callback", async (c) => {
    if (!opts.stateSecret) {
      return c.json<ErrorResponse>({ error: "state_secret_not_configured" }, 503);
    }
    if (!opts.github) {
      return c.json<ErrorResponse>({ error: "github_not_configured" }, 503);
    }

    const rawState = c.req.query("state") ?? "";
    const installationIdRaw = c.req.query("installation_id");
    if (!installationIdRaw) {
      return c.json<ErrorResponse>({ error: "missing_installation_id" }, 400);
    }
    const installationId = installationIdRaw;

    let claims: InstallStateClaims;
    try {
      claims = verifyState(opts.stateSecret, rawState);
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "invalid_state",
          details: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }

    let octokit: Awaited<ReturnType<typeof createOctokit>>;
    try {
      octokit = await createOctokitFn({
        creds: { ...opts.github, installationId },
      });
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "github_auth_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    // List repos this installation has access to. The user picked them
    // on the install page (typically just one).
    let repos: Array<{ owner: string; name: string }>;
    try {
      const accessible = await octokit.apps.listReposAccessibleToInstallation({
        per_page: 100,
      });
      repos = accessible.data.repositories.map((r) => ({
        owner: r.owner.login,
        name: r.name,
      }));
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "installation_listing_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    // Find the repo whose .render-harness/agent.json matches the
    // agentSlug from the signed state. Skip repos without the file or
    // with a different slug.
    let match: { owner: string; name: string; sha: string; metadata: AgentMetadata } | null = null;
    for (const repo of repos) {
      const found = await tryFetchMetadata(octokit, repo.owner, repo.name);
      if (!found) continue;
      if (found.metadata.agentSlug === claims.agentSlug) {
        match = { ...repo, ...found };
        break;
      }
    }

    if (!match) {
      return c.html(
        renderHtml(
          "Couldn't find your agent",
          `<p>Installed, but none of the repositories you selected contain a <code>.render-harness/agent.json</code> with <code>agentSlug: ${escapeHtml(claims.agentSlug)}</code>.</p><p>Pick the correct repo and retry the install.</p>`,
        ),
        404,
      );
    }

    const nextMetadata: AgentMetadata = {
      ...match.metadata,
      schemaVersion: match.metadata.schemaVersion ?? 1,
      agentSlug: claims.agentSlug,
      org: match.owner,
      repo: match.name,
      installationId,
    };

    try {
      await octokit.repos.createOrUpdateFileContents({
        owner: match.owner,
        repo: match.name,
        path: METADATA_PATH,
        message: "chore: record render-harness wizard installation",
        content: Buffer.from(`${JSON.stringify(nextMetadata, null, 2)}\n`, "utf8").toString(
          "base64",
        ),
        sha: match.sha,
        branch: "main",
      });
    } catch (err) {
      return c.json<ErrorResponse>(
        {
          error: "metadata_write_failed",
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    const safeNext = safeNextUrl(claims.next);
    return c.redirect(safeNext, 303);
  });
}

interface AgentMetadata {
  schemaVersion?: number;
  agentSlug?: string;
  org?: string | null;
  repo?: string | null;
  installationId?: string | null;
}

async function tryFetchMetadata(
  octokit: Awaited<ReturnType<typeof createOctokit>>,
  owner: string,
  repo: string,
): Promise<{ sha: string; metadata: AgentMetadata } | null> {
  try {
    const res = await octokit.repos.getContent({ owner, repo, path: METADATA_PATH });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file") return null;
    const text = Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return { sha: data.sha, metadata: parsed as AgentMetadata };
  } catch {
    // Missing file or unauthorized → not our match.
    return null;
  }
}

// --------------------------------------------------------------------
// State token (HMAC-signed; survives a redirect through GitHub)
// --------------------------------------------------------------------

function signState(secret: string, claims: InstallStateClaims): string {
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyState(secret: string, token: string): InstallStateClaims {
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
  ) as InstallStateClaims;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("expired");
  }
  if (typeof claims.agentSlug !== "string" || typeof claims.next !== "string") {
    throw new Error("missing claims");
  }
  return claims;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function safeNextUrl(next: string): string {
  // Don't allow protocol-relative or schemeless redirects to absorb
  // the wizard's host; only allow absolute URLs.
  try {
    const u = new URL(next);
    if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
  } catch {
    // not a URL
  }
  return "/";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderHtml(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:ui-monospace,monospace;max-width:60ch;margin:3rem auto;padding:0 1.5rem;line-height:1.5}code{padding:0.05rem 0.3rem;border:1px solid #000}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
