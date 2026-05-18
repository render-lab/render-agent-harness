/**
 * `WizardStore` — narrow data interface every wizard route depends on.
 *
 * Two implementations: `createPgStore(pool)` for production, and
 * `createMemoryStore()` for tests. Routes accept a `WizardStore`
 * directly so we never mock `pool.query` in tests.
 */

import type { Pool } from "pg";

export interface WizardUser {
  githubUserId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface ManagedRepo {
  org: string;
  repo: string;
  installationId: string;
  agentSlug: string | null;
  role: "owner" | "collaborator";
  createdAt: Date;
}

export interface UpsertUserInput {
  githubUserId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface AddRepoInput {
  githubUserId: number;
  org: string;
  repo: string;
  installationId: string;
  agentSlug: string | null;
  role?: "owner" | "collaborator";
}

export interface WizardStore {
  upsertUser(input: UpsertUserInput): Promise<WizardUser>;
  getUser(githubUserId: number): Promise<WizardUser | null>;
  addUserRepo(input: AddRepoInput): Promise<void>;
  listReposForUser(githubUserId: number): Promise<ManagedRepo[]>;
  /** Returns the row if the user is an authorized writer for this (org, repo). */
  getUserRepo(args: {
    githubUserId: number;
    org: string;
    repo: string;
  }): Promise<ManagedRepo | null>;
}

// ---------------------------------------------------------------------
// Postgres impl
// ---------------------------------------------------------------------

export function createPgStore(pool: Pool): WizardStore {
  return {
    async upsertUser(input) {
      const res = await pool.query<{
        github_user_id: string;
        login: string;
        name: string | null;
        avatar_url: string | null;
      }>(
        `INSERT INTO wizard_users (github_user_id, login, name, avatar_url, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (github_user_id) DO UPDATE
           SET login = EXCLUDED.login,
               name = EXCLUDED.name,
               avatar_url = EXCLUDED.avatar_url,
               updated_at = now()
         RETURNING github_user_id, login, name, avatar_url`,
        [input.githubUserId, input.login, input.name, input.avatarUrl],
      );
      const row = res.rows[0];
      if (!row) throw new Error("upsertUser: no row returned");
      return {
        githubUserId: Number(row.github_user_id),
        login: row.login,
        name: row.name,
        avatarUrl: row.avatar_url,
      };
    },
    async getUser(githubUserId) {
      const res = await pool.query<{
        github_user_id: string;
        login: string;
        name: string | null;
        avatar_url: string | null;
      }>(
        "SELECT github_user_id, login, name, avatar_url FROM wizard_users WHERE github_user_id = $1",
        [githubUserId],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        githubUserId: Number(row.github_user_id),
        login: row.login,
        name: row.name,
        avatarUrl: row.avatar_url,
      };
    },
    async addUserRepo(input) {
      await pool.query(
        `INSERT INTO wizard_user_repos
           (github_user_id, org, repo, installation_id, agent_slug, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (github_user_id, org, repo) DO UPDATE
           SET installation_id = EXCLUDED.installation_id,
               agent_slug = EXCLUDED.agent_slug,
               role = EXCLUDED.role`,
        [
          input.githubUserId,
          input.org,
          input.repo,
          input.installationId,
          input.agentSlug,
          input.role ?? "owner",
        ],
      );
    },
    async listReposForUser(githubUserId) {
      const res = await pool.query<{
        org: string;
        repo: string;
        installation_id: string;
        agent_slug: string | null;
        role: string;
        created_at: Date;
      }>(
        `SELECT org, repo, installation_id, agent_slug, role, created_at
         FROM wizard_user_repos
         WHERE github_user_id = $1
         ORDER BY created_at DESC`,
        [githubUserId],
      );
      return res.rows.map((row) => ({
        org: row.org,
        repo: row.repo,
        installationId: row.installation_id,
        agentSlug: row.agent_slug,
        role: row.role === "collaborator" ? "collaborator" : "owner",
        createdAt: row.created_at,
      }));
    },
    async getUserRepo({ githubUserId, org, repo }) {
      const res = await pool.query<{
        org: string;
        repo: string;
        installation_id: string;
        agent_slug: string | null;
        role: string;
        created_at: Date;
      }>(
        `SELECT org, repo, installation_id, agent_slug, role, created_at
         FROM wizard_user_repos
         WHERE github_user_id = $1 AND org = $2 AND repo = $3`,
        [githubUserId, org, repo],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        org: row.org,
        repo: row.repo,
        installationId: row.installation_id,
        agentSlug: row.agent_slug,
        role: row.role === "collaborator" ? "collaborator" : "owner",
        createdAt: row.created_at,
      };
    },
  };
}

// ---------------------------------------------------------------------
// Memory impl (tests + local dev without Postgres)
// ---------------------------------------------------------------------

export function createMemoryStore(): WizardStore {
  const users = new Map<number, WizardUser>();
  const repos = new Map<string, ManagedRepo & { githubUserId: number }>();
  const repoKey = (userId: number, org: string, repo: string) => `${userId}:${org}/${repo}`;

  return {
    async upsertUser(input) {
      const user: WizardUser = {
        githubUserId: input.githubUserId,
        login: input.login,
        name: input.name,
        avatarUrl: input.avatarUrl,
      };
      users.set(input.githubUserId, user);
      return user;
    },
    async getUser(id) {
      return users.get(id) ?? null;
    },
    async addUserRepo(input) {
      repos.set(repoKey(input.githubUserId, input.org, input.repo), {
        githubUserId: input.githubUserId,
        org: input.org,
        repo: input.repo,
        installationId: input.installationId,
        agentSlug: input.agentSlug,
        role: input.role ?? "owner",
        createdAt: new Date(),
      });
    },
    async listReposForUser(id) {
      const out: ManagedRepo[] = [];
      for (const value of repos.values()) {
        if (value.githubUserId !== id) continue;
        const { githubUserId: _id, ...rest } = value;
        out.push(rest);
      }
      out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return out;
    },
    async getUserRepo({ githubUserId, org, repo }) {
      const value = repos.get(repoKey(githubUserId, org, repo));
      if (!value) return null;
      const { githubUserId: _id, ...rest } = value;
      return rest;
    },
  };
}
