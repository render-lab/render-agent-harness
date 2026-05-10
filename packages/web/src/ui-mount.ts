import type { Logger, UserId } from "@render-harness/core";
import type { Hono } from "hono";

/**
 * Optional operator UI mount. The shape mirrors `@render-harness/ui`'s
 * `MountUiOpts` minus the fields the host already has (`app`, `pool`,
 * `agents`, `auth`, `apiPrefix`). Kept as a structural type so this
 * package doesn't depend on `@render-harness/ui` — it's loaded
 * dynamically when `ui` is set.
 */
export interface UiMountConfig {
  /** Mount path. Defaults to "/ui". */
  path?: string;
  /** Cookie session secret. Falls back to UI_COOKIE_SECRET env. */
  cookieSecret?: string;
  cookieName?: string;
  cookieMaxAge?: number;
  cookieSecure?: boolean;
  /** Override the directory containing the SPA bundle. */
  staticDir?: string;
}

interface MountUiArgs {
  auth: (req: Request) => Promise<UserId | null>;
  logger: Logger;
  path?: string;
  cookieSecret?: string;
  cookieName?: string;
  cookieMaxAge?: number;
  cookieSecure?: boolean;
  staticDir?: string;
}

/**
 * Dynamic-import shape of `@render-harness/ui`. Kept as a structural type
 * here so this package doesn't take a hard dependency on the UI module —
 * services that don't enable the UI don't pay the install / bundle cost.
 */
interface UiModule {
  mountUi: (opts: {
    app: Hono;
    auth: (req: Request) => Promise<UserId | null>;
    path?: string;
    cookieSecret?: string;
    cookieName?: string;
    cookieMaxAge?: number;
    cookieSecure?: boolean;
    staticDir?: string;
  }) => void;
  wrapWithSession: (
    upstream: (req: Request) => Promise<UserId | null>,
    opts: {
      cookieSecret?: string;
      cookieName?: string;
      cookieMaxAge?: number;
      cookieSecure?: boolean;
    },
  ) => (req: Request) => Promise<UserId | null>;
}

async function loadUiModule(logger: Logger): Promise<UiModule | null> {
  try {
    const specifier = "@render-harness/ui";
    return (await import(/* @vite-ignore */ specifier)) as UiModule;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "ui: failed to load @render-harness/ui — install the package or set ui: false",
    );
    return null;
  }
}

export async function wrapWithUiSessionIfAvailable(
  upstream: (req: Request) => Promise<UserId | null>,
  ui: boolean | UiMountConfig,
  logger: Logger,
): Promise<(req: Request) => Promise<UserId | null>> {
  const mod = await loadUiModule(logger);
  if (!mod) return upstream;
  const cfg = typeof ui === "object" ? ui : {};
  return mod.wrapWithSession(upstream, {
    ...(cfg.cookieSecret !== undefined ? { cookieSecret: cfg.cookieSecret } : {}),
    ...(cfg.cookieName !== undefined ? { cookieName: cfg.cookieName } : {}),
    ...(cfg.cookieMaxAge !== undefined ? { cookieMaxAge: cfg.cookieMaxAge } : {}),
    ...(cfg.cookieSecure !== undefined ? { cookieSecure: cfg.cookieSecure } : {}),
  });
}

export async function mountUiIfAvailable(app: Hono, args: MountUiArgs): Promise<void> {
  const mod = await loadUiModule(args.logger);
  if (!mod) return;
  mod.mountUi({
    app,
    auth: args.auth,
    ...(args.path !== undefined ? { path: args.path } : {}),
    ...(args.cookieSecret !== undefined ? { cookieSecret: args.cookieSecret } : {}),
    ...(args.cookieName !== undefined ? { cookieName: args.cookieName } : {}),
    ...(args.cookieMaxAge !== undefined ? { cookieMaxAge: args.cookieMaxAge } : {}),
    ...(args.cookieSecure !== undefined ? { cookieSecure: args.cookieSecure } : {}),
    ...(args.staticDir !== undefined ? { staticDir: args.staticDir } : {}),
  });
  args.logger.info({ path: args.path ?? "/ui" }, "ui: operator UI mounted");
}
