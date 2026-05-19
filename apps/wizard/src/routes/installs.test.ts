import type { Octokit } from "@octokit/rest";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerInstallsRoute } from "./installs.js";

const STATE_SECRET = "test-state-secret";

function makeOctokit(overrides: {
  listRepos?: ReturnType<typeof vi.fn>;
  getContent?: ReturnType<typeof vi.fn>;
  createOrUpdate?: ReturnType<typeof vi.fn>;
}): Octokit {
  return {
    apps: {
      listReposAccessibleToInstallation:
        overrides.listRepos ?? vi.fn(async () => ({ data: { repositories: [] } })),
    },
    repos: {
      getContent: overrides.getContent ?? vi.fn(async () => ({ data: { type: "file" } })),
      createOrUpdateFileContents: overrides.createOrUpdate ?? vi.fn(async () => ({ data: {} })),
    },
  } as unknown as Octokit;
}

function makeApp(overrides?: {
  octokit?: Octokit;
  appName?: string | null;
  stateSecret?: string | null;
}) {
  const app = new Hono();
  registerInstallsRoute(app, {
    appName: overrides?.appName === undefined ? "render-harness" : overrides.appName,
    github: overrides?.appName === null ? null : { appId: "1", privateKey: "key" },
    stateSecret: overrides?.stateSecret === undefined ? STATE_SECRET : overrides.stateSecret,
    publicUrl: "https://wizard.example.com",
    deps: {
      createOctokit: vi.fn(async () => overrides?.octokit ?? makeOctokit({})),
    },
  });
  return app;
}

describe("GET /api/installs/start", () => {
  it("302s to GitHub's App install page with a signed state", async () => {
    const app = makeApp();
    const res = await app.request(
      "/api/installs/start?agentSlug=my-agent&next=https://my-agent.onrender.com/ui/",
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("github.com/apps/render-harness/installations/new");
    expect(location).toContain("state=");
  });

  it("400s when agentSlug is missing", async () => {
    const app = makeApp();
    const res = await app.request("/api/installs/start");
    expect(res.status).toBe(400);
  });

  it("503s when GITHUB_APP_NAME isn't set", async () => {
    const app = makeApp({ appName: null });
    const res = await app.request("/api/installs/start?agentSlug=x");
    expect(res.status).toBe(503);
  });
});

describe("GET /api/installs/callback", () => {
  it("rejects invalid state tokens", async () => {
    const app = makeApp();
    const res = await app.request("/api/installs/callback?installation_id=99&state=bogus");
    expect(res.status).toBe(400);
  });

  it("finds the matching repo, writes back installationId, and redirects to next", async () => {
    // First grab a real signed state by hitting /start, then plug it
    // into the callback. Avoids reimplementing the HMAC here.
    const startApp = makeApp();
    const startRes = await startApp.request(
      "/api/installs/start?agentSlug=my-agent&next=https://my-agent.onrender.com/ui/",
    );
    const state = new URL(startRes.headers.get("location") ?? "").searchParams.get("state");
    expect(state).toBeTruthy();

    const listRepos = vi.fn(async () => ({
      data: {
        repositories: [
          { owner: { login: "alice" }, name: "wrong-repo" },
          { owner: { login: "alice" }, name: "my-agent-repo" },
        ],
      },
    }));
    const getContent = vi.fn(async ({ repo }: { repo: string }) => {
      if (repo === "wrong-repo") {
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(JSON.stringify({ agentSlug: "different-agent" }), "utf8").toString(
              "base64",
            ),
            sha: "wrong-sha",
          },
        };
      }
      return {
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              agentSlug: "my-agent",
              org: null,
              repo: null,
              installationId: null,
            }),
            "utf8",
          ).toString("base64"),
          sha: "match-sha",
        },
      };
    });
    const createOrUpdate = vi.fn(async () => ({ data: {} }));

    const app = makeApp({
      octokit: makeOctokit({ listRepos, getContent, createOrUpdate }),
    });
    const res = await app.request(
      `/api/installs/callback?installation_id=42&state=${encodeURIComponent(state ?? "")}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://my-agent.onrender.com/ui/");

    const writeCall = createOrUpdate.mock.calls[0]?.[0] as {
      owner: string;
      repo: string;
      content: string;
      sha: string;
    };
    expect(writeCall.owner).toBe("alice");
    expect(writeCall.repo).toBe("my-agent-repo");
    expect(writeCall.sha).toBe("match-sha");
    const written = JSON.parse(Buffer.from(writeCall.content, "base64").toString("utf8")) as {
      installationId: string;
      org: string;
      repo: string;
    };
    expect(written.installationId).toBe("42");
    expect(written.org).toBe("alice");
    expect(written.repo).toBe("my-agent-repo");
  });

  it("404s with a friendly page when no installed repo matches the agentSlug", async () => {
    const startApp = makeApp();
    const startRes = await startApp.request(
      "/api/installs/start?agentSlug=my-agent&next=https://example.com/",
    );
    const state = new URL(startRes.headers.get("location") ?? "").searchParams.get("state");

    const listRepos = vi.fn(async () => ({
      data: {
        repositories: [{ owner: { login: "alice" }, name: "unrelated-repo" }],
      },
    }));
    const getContent = vi.fn(async () => ({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from("{}").toString("base64"),
        sha: "x",
      },
    }));
    const app = makeApp({
      octokit: makeOctokit({ listRepos, getContent }),
    });
    const res = await app.request(
      `/api/installs/callback?installation_id=99&state=${encodeURIComponent(state ?? "")}`,
    );
    expect(res.status).toBe(404);
  });
});
