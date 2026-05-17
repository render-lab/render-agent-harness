/**
 * @render-harness/wizard — browser wizard that scaffolds a Render agent
 * project and creates a managed GitHub repo. Phase 3 of the onboarding
 * direction (docs/ui-scaffolder-plan.md).
 *
 * Single Hono service serving both the SPA (built into dist/static by
 * Vite) and the /api routes the SPA talks to.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolveGallery } from "create-render-agent";
import { Hono } from "hono";
import { parseEnv } from "./env.js";
import { createRateLimiter } from "./rate-limit.js";
import { registerAgentModelRoute } from "./routes/agent-model.js";
import { registerBrowseRoute } from "./routes/browse.js";
import { registerGalleryRoute } from "./routes/gallery.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerInstallsRoute } from "./routes/installs.js";
import { registerScaffoldRoute } from "./routes/scaffold.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// `dist/main.js` lives next to `dist/static/`; the bundled SPA is one
// directory away from the entry's resolved path.
const STATIC_ROOT = resolve(HERE, "static");
const DEFAULT_REGISTRY_INDEX_PATH = resolve(HERE, "..", "..", "..", "registry-index", "index.json");

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const gallery = await resolveGallery();

  const app = new Hono();

  registerHealthRoute(app);
  registerGalleryRoute(app, gallery);
  registerBrowseRoute(app, {
    gallery,
    communityIndexPath: env.registryIndexPath ?? DEFAULT_REGISTRY_INDEX_PATH,
  });
  registerScaffoldRoute(app, {
    org: env.managedOrg,
    repoPrefix: env.managedRepoPrefix,
    github: env.github,
    turnstileSecret: env.turnstile?.secret ?? null,
    gallery,
    rateLimiter: createRateLimiter({ capacity: 20, windowMs: 60 * 60 * 1_000 }),
    mockScaffold: env.mockScaffold,
  });

  // Phase 2: in-UI model edits. The deployed worker's proxy route
  // calls this with WIZARD_SHARED_SECRET in the Authorization header.
  registerAgentModelRoute(app, {
    sharedSecret: env.wizardSharedSecret,
    github: env.github ? { appId: env.github.appId, privateKey: env.github.privateKey } : null,
  });

  // GitHub App install flow for CLI-scaffolded agents.
  registerInstallsRoute(app, {
    appName: env.githubAppName,
    github: env.github ? { appId: env.github.appId, privateKey: env.github.privateKey } : null,
    stateSecret: env.stateSecret,
    publicUrl: env.publicUrl,
  });

  app.get("/", (c) => c.redirect("/browse", 302));

  // Serve the SPA as static content. Any path not claimed by /api or
  // /healthz falls through here; SPA routing is client-side, so the
  // Vite index.html serves every unknown path.
  app.use(
    "/*",
    serveStatic({
      root: STATIC_ROOT,
    }),
  );

  // SPA fallback for client-side routing (deep links return index.html).
  app.notFound(async (c) => c.html(await indexHtml()));

  serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
    process.stdout.write(
      `wizard listening on http://0.0.0.0:${info.port} (managed-org=${env.managedOrg}, repo-prefix=${env.managedRepoPrefix})\n`,
    );
  });
}

let cachedIndexHtml: string | null = null;

// Return the real Vite entry so history-mode routes such as /new and
// /browse work with hashed asset names in production.
async function indexHtml(): Promise<string> {
  if (cachedIndexHtml) return cachedIndexHtml;
  try {
    cachedIndexHtml = await readFile(resolve(STATIC_ROOT, "index.html"), "utf8");
    return cachedIndexHtml;
  } catch {
    return '<!doctype html><meta charset="utf-8"><title>Create a Render agent</title><div id="root"></div>';
  }
}

main().catch((err) => {
  process.stderr.write(`wizard fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
