/**
 * `mountUi(opts)` — attach the operator UI to an existing Hono app.
 *
 * The UI package owns the *browser-facing* surface only:
 *
 *   GET  <path>/               serves the SPA shell (HTML)
 *   GET  <path>/assets/*       serves the SPA's static bundle (JS/CSS/etc.)
 *   GET  <path>/login          login form (HTML)
 *   POST <path>/login          validate API key, set session cookie, redirect
 *   POST <path>/logout         clear the session cookie
 *
 * Every JSON+SSE endpoint the SPA talks to (`/runs`, `/runs/:id`,
 * `/runs/:id/tool-calls`, `/runs/:id/stream`, `/runs/:id/cancel`,
 * `/runs/:id/input`, `/agents`, `/usage`) is owned by `@render-harness/web`.
 * This package doesn't redefine any of them.
 *
 * The session cookie set by the login route is honoured by web's auth resolver
 * because `serveWeb({ ui: true })` wraps `auth()` with {@link wrapWithSession}.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import {
  type AuthResolver,
  authRequestForBearer,
  buildCookieConfig,
  clearSession,
  issueSession,
  readSessionCookie,
} from "./auth.js";

export type { AuthResolver } from "./auth.js";
export { wrapWithSession } from "./auth.js";

export interface MountUiOpts {
  /** Hono app the harness web service already built. */
  app: Hono;
  /**
   * Auth resolver from the parent. Used as the upstream check for the
   * login form; web's main `auth` already accepts the session cookie via
   * `wrapWithSession`, so we don't re-implement that here.
   */
  auth: AuthResolver;
  /** Mount path. Defaults to "/ui". */
  path?: string;
  /**
   * Cookie session secret. Falls back to `UI_COOKIE_SECRET` env, then to a
   * per-process random value (won't survive a restart — fine for dev).
   */
  cookieSecret?: string;
  /** Cookie name. Defaults to "rh_ui_session". */
  cookieName?: string;
  /** Cookie max age in seconds. Defaults to 7 days. */
  cookieMaxAge?: number;
  /** Force the Secure cookie flag. Defaults: true in production, false otherwise. */
  cookieSecure?: boolean;
  /**
   * Override the directory we serve the SPA bundle from. Defaults to the
   * `dist/static` shipped alongside this package's compiled JS.
   */
  staticDir?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/index.js → dist/static. In dev (src/server.ts → src/../dist/static)
// we still resolve up one level; we ship a built copy with the package.
const DEFAULT_STATIC_DIR = resolve(HERE, "..", "dist", "static");
const FALLBACK_STATIC_DIR = resolve(HERE, "static");

const SPA_INDEX = "index.html";

export function mountUi(opts: MountUiOpts): void {
  const path = normalizeMountPath(opts.path ?? "/ui");
  const cookie = buildCookieConfig({
    ...(opts.cookieName !== undefined ? { cookieName: opts.cookieName } : {}),
    ...(opts.cookieSecret !== undefined ? { secret: opts.cookieSecret } : {}),
    ...(opts.cookieMaxAge !== undefined ? { maxAge: opts.cookieMaxAge } : {}),
    ...(opts.cookieSecure !== undefined ? { secure: opts.cookieSecure } : {}),
  });

  const staticDir = opts.staticDir ?? DEFAULT_STATIC_DIR;

  // Login / logout
  opts.app.get(`${path}/login`, (c) =>
    c.html(renderLoginPage({ uiPath: path, error: c.req.query("error") ?? null })),
  );

  opts.app.post(`${path}/login`, async (c) => {
    const form = await c.req.formData().catch(() => null);
    const apiKey = typeof form?.get("apiKey") === "string" ? (form?.get("apiKey") as string) : "";
    if (!apiKey) {
      return c.redirect(`${path}/login?error=missing`, 303);
    }
    const userId = await opts.auth(authRequestForBearer(apiKey));
    if (!userId) {
      return c.redirect(`${path}/login?error=invalid`, 303);
    }
    await issueSession(c, cookie, userId);
    const next = c.req.query("next") ?? `${path}/`;
    return c.redirect(safeNextPath(next, path), 303);
  });

  opts.app.post(`${path}/logout`, (c) => {
    clearSession(c, cookie);
    return c.redirect(`${path}/login`, 303);
  });

  // SPA shell + assets. The shell itself is gated by the cookie session;
  // assets are not (they're cacheable static files).
  const serveSpaShell = async (c: Context) => {
    const userId = await readSessionCookie(c.req.raw, cookie);
    if (!userId) {
      const next = encodeURIComponent(c.req.path);
      return c.redirect(`${path}/login?next=${next}`, 303);
    }
    const html = await readBundleHtml(staticDir, SPA_INDEX);
    if (html === null) {
      return c.html(renderBuildMissingPage({ uiPath: path }), 503);
    }
    // The SPA shell is tiny and references hash-named asset bundles. We
    // don't want stale cached HTML pointing at deleted asset hashes, so
    // browsers must revalidate every load. Asset files (under
    // <path>/assets/*) are content-addressed and stay cacheable.
    c.header("cache-control", "no-cache, must-revalidate");
    return c.html(html);
  };

  const serveAsset = async (c: Context, rel: string) => {
    const buf = await readBundleAsset(staticDir, join("assets", rel));
    if (!buf) return c.notFound();
    // Hono's typed body() wants `Uint8Array<ArrayBuffer>`, not Node's
    // `Buffer<ArrayBufferLike>`. Copy into a fresh ArrayBuffer-backed
    // view so the type matches without resorting to `any`.
    const bytes = new Uint8Array(new ArrayBuffer(buf.byteLength));
    bytes.set(buf);
    return c.body(bytes, 200, {
      "content-type": guessContentType(rel),
      // Vite emits hash-named asset files; safe to cache aggressively.
      "cache-control": "public, max-age=31536000, immutable",
    });
  };

  // Root-level static files from Vite's `public/` directory (favicon,
  // manifest, etc.). These end up at `dist/static/<name>` rather than
  // `dist/static/assets/<name>`, so they need a different reader. Cache
  // less aggressively than hashed assets since the filename isn't
  // content-addressed.
  const serveRootStatic = async (c: Context, rel: string) => {
    const buf = await readBundleAsset(staticDir, rel);
    if (!buf) return c.notFound();
    const bytes = new Uint8Array(new ArrayBuffer(buf.byteLength));
    bytes.set(buf);
    return c.body(bytes, 200, {
      "content-type": guessContentType(rel),
      "cache-control": "public, max-age=3600",
    });
  };

  if (path === "") {
    opts.app.get("/assets/*", async (c) => serveAsset(c, c.req.path.replace(/^\/assets\//, "")));
    opts.app.get("/:asset", async (c, next) => {
      const asset = c.req.param("asset");
      if (isRootStaticName(asset)) return serveRootStatic(c, asset);
      if (isTopLevelAsset(asset)) return serveAsset(c, asset);
      return next();
    });
  }

  opts.app.get(path || "/", serveSpaShell);
  opts.app.get(`${path}/`, serveSpaShell);
  opts.app.get(`${path}/*`, async (c, next) => {
    const sub = c.req.path.slice(path.length);
    if (sub.startsWith("/assets/")) {
      const rel = sub.replace(/^\/assets\//, "");
      return serveAsset(c, rel);
    }
    if (sub === "/login" || sub.startsWith("/login?")) {
      return next();
    }
    const rootName = sub.startsWith("/") ? sub.slice(1) : sub;
    if (isRootStaticName(rootName)) return serveRootStatic(c, rootName);
    return serveSpaShell(c);
  });
}

// Files Vite copies from `web/public/` into the bundle root. Kept as a
// short, explicit allow-list rather than a wildcard so the SPA shell
// catch-all still handles unknown paths.
const ROOT_STATIC_FILES = new Set(["favicon.svg", "favicon.ico", "favicon.png", "robots.txt"]);

function isRootStaticName(name: string): boolean {
  return ROOT_STATIC_FILES.has(name);
}

function normalizeMountPath(raw: string): string {
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const trimmed = withSlash.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed;
}

// --------------------------------------------------------------------
// Static file helpers
// --------------------------------------------------------------------

async function readBundleHtml(staticDir: string, relPath: string): Promise<string | null> {
  const buf = await readBundleBytes(staticDir, relPath);
  return buf ? buf.toString("utf8") : null;
}

async function readBundleAsset(staticDir: string, relPath: string): Promise<Buffer | null> {
  return readBundleBytes(staticDir, relPath);
}

async function readBundleBytes(staticDir: string, relPath: string): Promise<Buffer | null> {
  const candidates = [staticDir, FALLBACK_STATIC_DIR];
  for (const dir of candidates) {
    const safe = safeJoin(dir, relPath);
    if (!safe) continue;
    try {
      const s = await stat(safe);
      if (!s.isFile()) continue;
      return await readFile(safe);
    } catch {
      // try the next candidate directory
    }
  }
  return null;
}

function safeJoin(root: string, rel: string): string | null {
  const resolved = normalize(join(root, rel));
  const rootResolved = `${normalize(root)}/`.replace(/\/+$/, "/");
  return resolved.startsWith(rootResolved) || resolved === normalize(root) ? resolved : null;
}

function guessContentType(rel: string): string {
  if (rel.endsWith(".js") || rel.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (rel.endsWith(".css")) return "text/css; charset=utf-8";
  if (rel.endsWith(".svg")) return "image/svg+xml";
  if (rel.endsWith(".png")) return "image/png";
  if (rel.endsWith(".woff2")) return "font/woff2";
  if (rel.endsWith(".json")) return "application/json; charset=utf-8";
  if (rel.endsWith(".map")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function isTopLevelAsset(path: string): boolean {
  return (
    !path.includes("/") &&
    (path.endsWith(".js") ||
      path.endsWith(".mjs") ||
      path.endsWith(".css") ||
      path.endsWith(".map") ||
      path.endsWith(".woff2") ||
      path.endsWith(".svg") ||
      path.endsWith(".png"))
  );
}

function safeNextPath(next: string, uiPath: string): string {
  // Only allow same-origin redirects under the UI path prefix to avoid
  // open-redirects via the `next` query param.
  if (!next.startsWith("/")) return `${uiPath}/`;
  if (next.startsWith("//")) return `${uiPath}/`;
  return next;
}

// --------------------------------------------------------------------
// Inline HTML helpers (login + the "build missing" fallback)
// --------------------------------------------------------------------

// Brutalist black-and-white CSS shared by the inline pages we render
// outside the SPA bundle (login form, "build missing" fallback). Kept
// here so server-only routes don't depend on the Tailwind output.
//
// Single accent: purple. Used for active states, focus, selection, and
// the blinking input caret. Same palette as the SPA so the visual
// transition into the dashboard is seamless.
const INLINE_THEME_CSS = `
:root {
  color-scheme: light dark;
  --bg: #fff; --fg: #000; --muted: #555; --line: #000;
  --accent: #a855f7; --err: #b40000;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000; --fg: #fff; --muted: #8a8a8a; --line: #2a2a2a;
    --accent: #c084fc; --err: #ff5555;
  }
}
* { box-sizing: border-box; border-radius: 0 !important; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.45 ui-monospace, "JetBrains Mono", "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace;
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--accent); color: var(--bg); }
.label {
  text-transform: uppercase; letter-spacing: 0.08em;
  font-size: 0.72rem; color: var(--muted);
}
.panel { border: 1px solid var(--line); background: var(--bg); }
.hr-section {
  display: flex; align-items: center; gap: 0.6rem;
  text-transform: uppercase; letter-spacing: 0.1em;
  font-size: 0.72rem; color: var(--muted);
  margin: 0 0 1rem;
}
.hr-section::after {
  content: ""; flex: 1; border-top: 1px solid var(--line);
}
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 100%; padding: 0.6rem 0.7rem; border: 1px solid var(--accent);
  background: var(--accent); color: var(--bg); cursor: pointer;
  font: inherit; text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.78rem;
}
.btn:hover { background: var(--bg); color: var(--accent); }
input {
  width: 100%; padding: 0.55rem 0.65rem; font: inherit; color: inherit;
  background: var(--bg); border: 1px solid var(--line);
  caret-color: var(--accent);
}
input:focus-visible {
  outline: 1px solid var(--accent); outline-offset: 0;
  border-color: var(--accent);
  animation: rh-caret-blink 1.06s steps(2, jump-none) infinite;
}
@keyframes rh-caret-blink {
  0%, 50% { caret-color: var(--accent); }
  51%, 100% { caret-color: transparent; }
}
.blink { animation: rh-block-blink 1.06s steps(2, jump-none) infinite; }
@keyframes rh-block-blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}
.cursor { color: var(--accent); }
code { font-family: inherit; }
`;

function renderLoginPage(args: { uiPath: string; error: string | null }): string {
  const errorHtml =
    args.error === "invalid"
      ? '<p class="err">// invalid api key</p>'
      : args.error === "missing"
        ? '<p class="err">// enter the api key configured as <code>WEB_API_KEY</code></p>'
        : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>render-harness / operator / sign-in</title>
    <style>
      ${INLINE_THEME_CSS}
      main { min-height: 100vh; display: grid; place-items: center; padding: 2rem 1rem; }
      .card { width: min(440px, 100%); padding: 1.75rem; }
      .card h1 {
        margin: 0; font-size: 0.85rem; text-transform: uppercase;
        letter-spacing: 0.1em;
      }
      .card h1 .muted { color: var(--muted); }
      .card .sub {
        margin: 0.25rem 0 1.5rem; color: var(--muted);
        font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;
      }
      .card p.help { margin: 0 0 1.25rem; color: var(--muted); font-size: 0.78rem; }
      .field { margin-bottom: 0.9rem; }
      .field label { display: block; margin-bottom: 0.35rem; }
      .prompt {
        display: flex; align-items: stretch; gap: 0.5rem;
      }
      .prompt .gutter {
        display: flex; align-items: center;
        color: var(--accent); font-size: 0.85rem;
      }
      .err { margin: 0.6rem 0 0; color: var(--err); font-size: 0.78rem; }
    </style>
  </head>
  <body>
    <main>
      <form class="panel card" method="post" action="${escapeHtml(args.uiPath)}/login">
        <h1>
          <span class="muted">render-harness</span> / operator<span class="cursor blink" aria-hidden="true">▊</span>
        </h1>
        <p class="sub">/sign-in</p>
        <p class="help">// enter the api key configured for this service (<code>WEB_API_KEY</code>)</p>
        <div class="field">
          <label class="label" for="apiKey">api key</label>
          <div class="prompt">
            <span class="gutter" aria-hidden="true">$</span>
            <input id="apiKey" name="apiKey" type="password" autocomplete="current-password" required autofocus />
          </div>
        </div>
        <button class="btn" type="submit">[ continue ]</button>
        ${errorHtml}
      </form>
    </main>
  </body>
</html>`;
}

function renderBuildMissingPage(args: { uiPath: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>render-harness / operator / build-missing</title>
    <style>
      ${INLINE_THEME_CSS}
      main { max-width: 60ch; margin: 4rem auto; padding: 0 1.5rem; }
      h1 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 1rem; }
      .box { padding: 1rem; }
      code { padding: 0.05rem 0.3rem; border: 1px solid var(--line); }
    </style>
  </head>
  <body>
    <main>
      <h1>// operator ui bundle missing</h1>
      <div class="panel box">
        <p>The SPA bundle for <code>@render-harness/ui</code> hasn't been built. Run</p>
        <p><code>pnpm --filter @render-harness/ui build</code></p>
        <p>to compile it, then reload <code>${escapeHtml(args.uiPath)}/</code>.</p>
      </div>
    </main>
  </body>
</html>`;
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
