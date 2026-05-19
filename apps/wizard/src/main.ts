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
import { applyWizardMigrations, createWizardPool } from "./db.js";
import { parseEnv } from "./env.js";
import { createRateLimiter } from "./rate-limit.js";
import { registerAgentAddRoute } from "./routes/agent-add.js";
import { registerAgentModelRoute } from "./routes/agent-model.js";
import { registerAgentSystemPromptRoute } from "./routes/agent-system-prompt.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBrowseRoute } from "./routes/browse.js";
import { registerCapabilityInstallRoute } from "./routes/capability-install.js";
import { registerGalleryRoute } from "./routes/gallery.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerInstallsRoute } from "./routes/installs.js";
import { registerMyRoutes } from "./routes/my.js";
import { registerScaffoldRoute } from "./routes/scaffold.js";
import { createPgStore, type WizardStore } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// `dist/main.js` lives next to `dist/static/`; the bundled SPA is one
// directory away from the entry's resolved path.
const STATIC_ROOT = resolve(HERE, "static");
const DEFAULT_REGISTRY_INDEX_PATH = resolve(HERE, "..", "..", "..", "registry-index", "index.json");

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const gallery = await resolveGallery();

  // Optional Postgres + ownership store. Without DATABASE_URL the
  // wizard runs in "stateless" mode: bearer-secret routes work,
  // session-cookie auth + /my routes return 503.
  let store: WizardStore | null = null;
  if (env.databaseUrl) {
    const pool = createWizardPool({ connectionString: env.databaseUrl });
    const applied = await applyWizardMigrations(pool);
    process.stdout.write(`wizard migrations applied: ${applied.join(", ")}\n`);
    store = createPgStore(pool);
  }

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
    ...(store ? { store } : {}),
    sessionSecret: env.sessionSecret,
    publicUrl: env.publicUrl,
  });
  if (store) {
    registerAuthRoutes(app, {
      store,
      sessionSecret: env.sessionSecret,
      clientId: env.oauthClientId,
      clientSecret: env.oauthClientSecret,
      publicUrl: env.publicUrl,
    });
    registerMyRoutes(app, {
      store,
      sessionSecret: env.sessionSecret,
      claimSecret: env.sessionSecret,
      github: env.github ? { appId: env.github.appId, privateKey: env.github.privateKey } : null,
      publicUrl: env.publicUrl,
    });
  }

  // Phase 2: in-UI model edits. The deployed worker's proxy route
  // calls this with WIZARD_SHARED_SECRET in the Authorization header.
  registerAgentModelRoute(app, {
    sharedSecret: env.wizardSharedSecret,
    github: env.github ? { appId: env.github.appId, privateKey: env.github.privateKey } : null,
  });
  // Sibling of agent-model: in-UI system-prompt edits for builtin chat
  // agents. Custom (TS-entrypoint) agents return a 409 with a pointer to
  // their entrypoint instead.
  registerAgentSystemPromptRoute(app, {
    sharedSecret: env.wizardSharedSecret,
    github: env.github ? { appId: env.github.appId, privateKey: env.github.privateKey } : null,
  });
  registerCapabilityInstallRoute(app, {
    sharedSecret: env.wizardSharedSecret,
    github: env.github ? { appId: env.github.appId, privateKey: env.github.privateKey } : null,
  });
  registerAgentAddRoute(app, {
    sharedSecret: env.wizardSharedSecret,
    github: env.github ? { appId: env.github.appId, privateKey: env.github.privateKey } : null,
    gallery,
    ...(store ? { store } : {}),
    sessionSecret: env.sessionSecret,
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
