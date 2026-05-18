import type { Octokit } from "@octokit/rest";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { setSessionCookie } from "../auth.js";
import { createMemoryStore } from "../store.js";
import { registerMyRoutes, signClaimToken } from "./my.js";

const SECRET = "session-secret";

function makeApp(opts: { addCollaborator?: ReturnType<typeof vi.fn> } = {}) {
  const store = createMemoryStore();
  const addCollaborator = opts.addCollaborator ?? vi.fn(async () => ({}));
  const fakeOctokit = { repos: { addCollaborator } } as unknown as Octokit;
  const app = new Hono();
  registerMyRoutes(app, {
    store,
    sessionSecret: SECRET,
    claimSecret: SECRET,
    github: { appId: "1", privateKey: "key" },
    publicUrl: "http://localhost:8090",
    deps: { createOctokit: vi.fn(async () => fakeOctokit) },
  });
  // Helper route to seed a session cookie in tests.
  app.get("/seed-session/:userId", (c) => {
    const userId = Number(c.req.param("userId"));
    setSessionCookie(c, SECRET, userId);
    return c.text("ok");
  });
  return { app, store, addCollaborator };
}

async function getSessionCookie(
  app: Hono,
  userId: number,
  store: ReturnType<typeof createMemoryStore>,
): Promise<string> {
  await store.upsertUser({
    githubUserId: userId,
    login: "alice",
    name: null,
    avatarUrl: null,
  });
  const res = await app.request(`/seed-session/${userId}`);
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

describe("/api/my/harnesses", () => {
  it("401 without session", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/my/harnesses");
    expect(res.status).toBe(401);
  });

  it("lists rows for the authenticated user", async () => {
    const { app, store } = makeApp();
    const cookie = await getSessionCookie(app, 1, store);
    await store.addUserRepo({
      githubUserId: 1,
      org: "org",
      repo: "repo",
      installationId: "inst",
      agentSlug: "chat",
    });
    const res = await app.request("/api/my/harnesses", { headers: { cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { harnesses: Array<{ org: string }> };
    expect(json.harnesses).toHaveLength(1);
    expect(json.harnesses[0]?.org).toBe("org");
  });
});

describe("GET /api/harnesses/claim", () => {
  it("redirects to /login when not signed in", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/harnesses/claim?token=anything");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/api/auth/login");
  });

  it("verifies token, adds collaborator, inserts user-repo row", async () => {
    const { app, store, addCollaborator } = makeApp();
    const cookie = await getSessionCookie(app, 7, store);
    const token = signClaimToken(SECRET, {
      org: "myorg",
      repo: "myrepo",
      installationId: "inst-9",
      agentSlug: "chat",
    });
    const res = await app.request(`/api/harnesses/claim?token=${encodeURIComponent(token)}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(302);
    expect(addCollaborator).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "myorg", repo: "myrepo", username: "alice" }),
    );
    const repos = await store.listReposForUser(7);
    expect(repos).toHaveLength(1);
    expect(repos[0]?.installationId).toBe("inst-9");
  });

  it("rejects an invalid token", async () => {
    const { app, store } = makeApp();
    const cookie = await getSessionCookie(app, 7, store);
    const res = await app.request("/api/harnesses/claim?token=bogus", { headers: { cookie } });
    expect(res.status).toBe(400);
  });
});
