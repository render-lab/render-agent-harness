/**
 * `@render-harness/ui` — operator control-plane UI for the harness.
 *
 * Mounts a Hono router that serves a small React SPA at a configurable path.
 * Browser-facing routes only (SPA shell, assets, login, logout). All
 * JSON+SSE endpoints the SPA talks to are owned by `@render-harness/web`
 * — this package doesn't redefine any of them.
 *
 * The session cookie set by the login route is honoured by web's auth
 * resolver because `serveWeb({ ui: true })` wraps `auth()` with
 * {@link wrapWithSession}. That keeps the API surface in one place
 * while still letting browsers stay logged in across requests.
 */

export type { AuthResolver, MountUiOpts } from "./server.js";
export { mountUi, wrapWithSession } from "./server.js";
