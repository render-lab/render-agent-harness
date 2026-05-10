/**
 * HTTP-level integration tests for the /runs route bundle. Spins the Hono
 * app up in-process (no socket) against a live Postgres via app.fetch(),
 * with a stub PgBoss that just records sends. Skipped when Postgres is
 * unreachable, mirroring repo.integration.test.ts.
 */

import {
  type AgentDefinition,
  appendMessage,
  applyMigrations,
  buildLogger,
  closeSharedPool,
  createPool,
  createRun,
  type Pool,
  setRunStatus,
  type UserId,
} from "@render-harness/core";
import { Hono } from "hono";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRunRoutes } from "./runs.js";

const CONN = process.env.TEST_DATABASE_URL ?? "postgres://harness:harness@127.0.0.1:55432/harness";

let pool: Pool | null = null;

beforeAll(async () => {
  try {
    pool = createPool({ connectionString: CONN, applicationName: "web-runs-it" });
    await pool.query("SELECT 1");
    await applyMigrations(pool);
  } catch {
    pool = null;
  }
});

afterAll(async () => {
  await pool?.end();
  await closeSharedPool();
});

const dbTest = (name: string, fn: (db: Pool) => Promise<void>) => {
  it(name, async () => {
    if (!pool) {
      console.warn(`[skip] ${name}: no Postgres reachable at ${CONN}`);
      return;
    }
    await fn(pool);
  });
};

interface SentJob {
  queue: string;
  data: unknown;
}

const TEST_AGENT: AgentDefinition = {
  name: "web-runs-test-agent",
  version: "0.0.0",
  model: { provider: "anthropic", model: "claude-test" },
  systemPrompt: "test",
};

function buildTestApp(
  db: Pool,
  agents: Record<string, AgentDefinition> = { [TEST_AGENT.name]: TEST_AGENT },
) {
  const sentJobs: SentJob[] = [];
  const fakeBoss = {
    send: async (queue: string, data: unknown) => {
      sentJobs.push({ queue, data });
      return null as unknown as string;
    },
  } as unknown as PgBoss;

  // Header-based auth for tests: x-test-user → userId; absent → null (401).
  const auth = async (req: Request) => {
    const u = req.headers.get("x-test-user");
    return (u && u.length > 0 ? u : null) as UserId | null;
  };

  const app = new Hono();
  registerRunRoutes(app, {
    pool: db,
    boss: fakeBoss,
    auth,
    logger: buildLogger({ level: "silent" }),
    agents,
    queue: "test-queue",
    connectionString: CONN,
    pathPrefix: "",
  });
  return { app, sentJobs };
}

describe("POST /runs", () => {
  dbTest("rejects unauthenticated request with 401", async (db) => {
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request("http://x/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  dbTest("rejects empty body.input with 400 invalid_input", async (db) => {
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request("http://x/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "u-1" },
        body: JSON.stringify({ input: "  " }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });

  dbTest("rejects unknown agent with 400 unknown_agent", async (db) => {
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request("http://x/runs?agent=does-not-exist", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "u-1" },
        body: JSON.stringify({ input: "hi" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_agent");
  });

  dbTest("creates run row, initial message, and sends boss job", async (db) => {
    const { app, sentJobs } = buildTestApp(db);
    const res = await app.fetch(
      new Request("http://x/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "u-create" },
        body: JSON.stringify({ input: "hello world", metadata: { source: "test" } }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; status: string };
    expect(typeof body.runId).toBe("string");
    expect(body.status).toBe("pending");

    const runRow = await db.query<{ agent_name: string; user_id: string }>(
      "SELECT agent_name, user_id FROM agent_runs WHERE id = $1",
      [body.runId],
    );
    expect(runRow.rowCount).toBe(1);
    expect(runRow.rows[0]?.agent_name).toBe(TEST_AGENT.name);
    expect(runRow.rows[0]?.user_id).toBe("u-create");

    const msgRow = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM agent_messages WHERE run_id = $1",
      [body.runId],
    );
    expect(msgRow.rows[0]?.n).toBe(1);

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe("test-queue");
  });
});

describe("POST /runs/:id/cancel", () => {
  dbTest("returns 401 without auth", async (db) => {
    const { app } = buildTestApp(db);
    const res = await app.fetch(new Request("http://x/runs/anything/cancel", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  dbTest("returns 404 for unknown run id", async (db) => {
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request("http://x/runs/no-such-run/cancel", {
        method: "POST",
        headers: { "x-test-user": "u-1" },
      }),
    );
    expect(res.status).toBe(404);
  });

  dbTest("returns 200 cancelRequested:false for terminal run (no-op)", async (db) => {
    const id = `cancel-terminal-${Date.now()}`;
    await createRun(db, {
      id,
      agentName: "x",
      agentVersion: "0",
      userId: "u-cancel-term",
    });
    await setRunStatus(db, id, "completed");

    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/runs/${id}/cancel`, {
        method: "POST",
        headers: { "x-test-user": "u-cancel-term" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelRequested: boolean; status: string };
    expect(body.cancelRequested).toBe(false);
    expect(body.status).toBe("completed");
  });

  dbTest("paused run flips status to cancelled", async (db) => {
    const id = `cancel-paused-${Date.now()}`;
    await createRun(db, {
      id,
      agentName: "x",
      agentVersion: "0",
      userId: "u-cancel-paused",
    });
    await setRunStatus(db, id, "paused");

    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/runs/${id}/cancel`, {
        method: "POST",
        headers: { "x-test-user": "u-cancel-paused" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelRequested: boolean; status: string };
    expect(body.cancelRequested).toBe(true);
    expect(body.status).toBe("cancelled");

    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM agent_runs WHERE id = $1",
      [id],
    );
    expect(rows[0]?.status).toBe("cancelled");
  });

  dbTest("does not leak across users (u-A cancelling u-B's run is a 404)", async (db) => {
    const id = `cancel-cross-${Date.now()}`;
    await createRun(db, {
      id,
      agentName: "x",
      agentVersion: "0",
      userId: "u-owner",
    });
    await setRunStatus(db, id, "paused");

    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/runs/${id}/cancel`, {
        method: "POST",
        headers: { "x-test-user": "u-other" },
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /runs/:id/stream replay", () => {
  dbTest("replays past messages and emits done for already-terminal run", async (db) => {
    const id = `stream-terminal-${Date.now()}`;
    await createRun(db, {
      id,
      agentName: "x",
      agentVersion: "0",
      userId: "u-stream",
    });
    await appendMessage(db, {
      runId: id,
      role: "user",
      content: [{ type: "text", text: "first" }],
    });
    await appendMessage(db, {
      runId: id,
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    });
    await setRunStatus(db, id, "completed");

    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/runs/${id}/stream`, {
        headers: { "x-test-user": "u-stream" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const body = await res.text();
    // Two replayed message events plus the terminal "done" event.
    const messageEvents = body.match(/^event: message$/gm) ?? [];
    expect(messageEvents).toHaveLength(2);
    expect(body).toMatch(/"text":"first"/);
    expect(body).toMatch(/"text":"second"/);
    expect(body).toMatch(/event: done/);
    expect(body).toMatch(/"status":"completed"/);
  });

  dbTest("returns 404 when stream is requested by a non-owner", async (db) => {
    const id = `stream-cross-${Date.now()}`;
    await createRun(db, {
      id,
      agentName: "x",
      agentVersion: "0",
      userId: "u-stream-owner",
    });
    await setRunStatus(db, id, "completed");

    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/runs/${id}/stream`, {
        headers: { "x-test-user": "u-stream-other" },
      }),
    );
    expect(res.status).toBe(404);
  });
});
