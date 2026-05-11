/**
 * GitHub App helpers. Two roles:
 *
 *   1. `createOctokit()` — mint a short-lived installation token via
 *      `@octokit/auth-app` and return an authenticated Octokit client.
 *      Called once per wizard request.
 *
 *   2. `createScaffoldedRepo()` — given an authed Octokit, a file map,
 *      and a target name, create a repo in the managed org and push the
 *      initial commit. Returns `{ repoUrl, repoName }`.
 *
 * The functions take their dependencies as parameters (no global env
 * read, no module-level singletons) so unit tests can swap Octokit for
 * a fake without monkey-patching.
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface GithubAppCreds {
  appId: string;
  privateKey: string;
  installationId: string;
}

export interface CreateOctokitOpts {
  creds: GithubAppCreds;
}

/**
 * Mint an installation token and return an Octokit authenticated with it.
 * The token is short-lived (1h); call this per request rather than
 * caching the client.
 */
export async function createOctokit(opts: CreateOctokitOpts): Promise<Octokit> {
  const auth = createAppAuth({
    appId: opts.creds.appId,
    privateKey: opts.creds.privateKey,
    installationId: opts.creds.installationId,
  });
  const { token } = await auth({ type: "installation" });
  return new Octokit({ auth: token });
}

export interface CreateScaffoldedRepoOpts {
  octokit: Octokit;
  org: string;
  /**
   * Desired repo name. The function appends a 4-hex random suffix to
   * avoid collisions; the actual created name is returned.
   */
  desiredName: string;
  description: string;
  files: Map<string, string>;
}

export interface CreateScaffoldedRepoResult {
  repoName: string;
  repoUrl: string;
  commitSha: string;
}

export async function createScaffoldedRepo(
  opts: CreateScaffoldedRepoOpts,
): Promise<CreateScaffoldedRepoResult> {
  const repoName = `${opts.desiredName}-${randomSuffix()}`;

  const { data: repo } = await opts.octokit.repos.createInOrg({
    org: opts.org,
    name: repoName,
    private: true,
    auto_init: false,
    description: opts.description.slice(0, 250),
    has_issues: false,
    has_projects: false,
    has_wiki: false,
  });

  // Build a single tree from the file map, then create a root commit and
  // point refs/heads/main at it. Doing it in one tree+commit (rather
  // than one commit per file) keeps the history clean and the API call
  // count low.
  const { data: tree } = await opts.octokit.git.createTree({
    owner: opts.org,
    repo: repoName,
    tree: [...opts.files.entries()].map(([path, content]) => ({
      path,
      mode: "100644",
      type: "blob",
      content,
    })),
  });

  const { data: commit } = await opts.octokit.git.createCommit({
    owner: opts.org,
    repo: repoName,
    message: "Initial scaffold via create-render-agent wizard",
    tree: tree.sha,
    parents: [],
  });

  await opts.octokit.git.createRef({
    owner: opts.org,
    repo: repoName,
    ref: "refs/heads/main",
    sha: commit.sha,
  });

  return {
    repoName,
    repoUrl: repo.html_url,
    commitSha: commit.sha,
  };
}

function randomSuffix(): string {
  // 4 hex chars = 16 bits = ~65k slots. Combined with the agent name
  // (typically kebab-case slug), collision probability is negligible.
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the Render Blueprint deploy URL for a given repo. End users
 * click this; Render reads the committed render.yaml, prompts for env
 * vars, and provisions services.
 */
export function buildDeployUrl(repoUrl: string): string {
  const u = new URL("https://render.com/deploy");
  u.searchParams.set("repo", repoUrl);
  return u.toString();
}
