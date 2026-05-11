/**
 * @render-harness/wizard — browser wizard that scaffolds a Render agent
 * project and creates a managed GitHub repo. Phase 3 of the onboarding
 * direction (docs/ui-scaffolder-plan.md).
 *
 * Single Hono service serving both the SPA (built into dist/static by
 * Vite) and the /api routes the SPA talks to.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolveGallery } from "create-render-agent";
import { Hono } from "hono";
import { parseEnv } from "./env.js";
import { createRateLimiter } from "./rate-limit.js";
import { registerGalleryRoute } from "./routes/gallery.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerScaffoldRoute } from "./routes/scaffold.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// `dist/main.js` lives next to `dist/static/`; the bundled SPA is one
// directory away from the entry's resolved path.
const STATIC_ROOT = resolve(HERE, "static");

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const gallery = await resolveGallery();

  const app = new Hono();

  registerHealthRoute(app);
  registerGalleryRoute(app, gallery);
  registerScaffoldRoute(app, {
    org: env.managedOrg,
    github: env.github,
    turnstileSecret: env.turnstile?.secret ?? null,
    gallery,
    rateLimiter: createRateLimiter({ capacity: 20, windowMs: 60 * 60 * 1_000 }),
    mockScaffold: env.mockScaffold,
  });

  // Serve the SPA as static content. Any path not claimed by /api or
  // /healthz falls through here; SPA routing is client-side, so the
  // root index.html serves every unknown path.
  app.use(
    "/*",
    serveStatic({
      root: STATIC_ROOT,
      rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
    }),
  );

  // SPA fallback for client-side routing (deep links return index.html).
  app.notFound((c) => c.html(indexHtml()));

  serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
    process.stdout.write(
      `wizard listening on http://0.0.0.0:${info.port} (managed-org=${env.managedOrg})\n`,
    );
  });
}

// Cheap inline fallback so 404s on unknown paths still return the SPA.
// In production, serveStatic should handle /index.html directly; this
// is a safety net.
function indexHtml(): string {
  return `<!doctype html><meta charset="utf-8"><title>Create a Render agent</title><div id="root"></div><script type="module" src="/assets/main.js"></script>`;
}

main().catch((err) => {
  process.stderr.write(`wizard fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
