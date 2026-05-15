/**
 * Required + optional env vars for the wizard service. Parsed once at
 * boot so failures surface immediately with clear messages.
 */
export interface WizardEnv {
  port: number;
  managedOrg: string;
  publicUrl: string;
  github: {
    appId: string;
    privateKey: string;
    installationId: string;
  } | null;
  turnstile: {
    secret: string;
  } | null;
  /**
   * Local-dev convenience. When true, /api/scaffold returns a fake repo
   * URL without calling GitHub. Lets developers click through the
   * wizard end-to-end without setting up a GitHub App. Production
   * deployments must leave this unset.
   */
  mockScaffold: boolean;
  /**
   * Shared secret used to authenticate server-to-server PATCH requests
   * from a deployed worker's `/agents/:slug/model` proxy route. Same
   * value must be set on both services. Unset = `/api/agents/:slug/model`
   * returns 503.
   */
  wizardSharedSecret: string | null;
  /**
   * HMAC secret used to sign the install-flow state token. Unset =
   * install routes return 503.
   */
  stateSecret: string | null;
  /**
   * Slug of the GitHub App as it appears in the install URL:
   * `https://github.com/apps/<APP_NAME>/installations/new`. Unset =
   * `/api/installs/start` returns 503.
   */
  githubAppName: string | null;
}

export function parseEnv(env: NodeJS.ProcessEnv): WizardEnv {
  const port = Number(env.PORT ?? 8090);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, got ${env.PORT}`);
  }
  const managedOrg = env.MANAGED_ORG ?? "render-lab-agents";
  const publicUrl = env.WIZARD_PUBLIC_URL ?? `http://127.0.0.1:${port}`;

  const github =
    env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID
      ? {
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
          installationId: env.GITHUB_APP_INSTALLATION_ID,
        }
      : null;

  const turnstile = env.TURNSTILE_SECRET_KEY ? { secret: env.TURNSTILE_SECRET_KEY } : null;

  const mockScaffold = env.MOCK_SCAFFOLD === "1" || env.MOCK_SCAFFOLD === "true";

  const wizardSharedSecret = env.WIZARD_SHARED_SECRET ?? null;
  const stateSecret = env.WIZARD_STATE_SECRET ?? null;
  const githubAppName = env.GITHUB_APP_NAME ?? null;

  return {
    port,
    managedOrg,
    publicUrl,
    github,
    turnstile,
    mockScaffold,
    wizardSharedSecret,
    stateSecret,
    githubAppName,
  };
}
