/**
 * HTTP-level integration tests for the /conversations route bundle. Mirrors
 * the runs.integration.test.ts pattern: in-process Hono app with a stub
 * PgBoss against a live Postgres. Skipped when Postgres is unreachable.
 */

import {
  type AgentDefinition,
  appendMessage,
  applyMigrations,
  buildLogger,
  closeSharedPool,
  createConversation,
  createPool,
  createRun,
  type Pool,
  setRunStatus,
  type UserId,
} from "@render-harness/core";
import { Hono } from "hono";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerConversationRoutes } from "./conversations.js";

const CONN = process.env.TEST_DATABASE_URL ?? "postgres://harness:harness@127.0.0.1:55432/harness";

let pool: Pool | null = null;

beforeAll(async () => {
  try {
    pool = createPool({ connectionString: CONN, applicationName: "web-conv-it" });
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
  name: "web-conv-test-agent",
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

  const auth = async (req: Request) => {
    const u = req.headers.get("x-test-user");
    return (u && u.length > 0 ? u : null) as UserId | null;
  };

  const app = new Hono();
  registerConversationRoutes(app, {
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

describe("POST /conversations", () => {
  dbTest("returns 401 without auth", async (db) => {
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request("http://x/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });

  dbTest("creates a conversation row scoped to the caller", async (db) => {
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request("http://x/conversations", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "u-create" },
        body: JSON.stringify({ title: "first" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { conversation: { id: string; userId: string } };
    expect(typeof body.conversation.id).toBe("string");
    expect(body.conversation.userId).toBe("u-create");

    const { rows } = await db.query<{ user_id: string; title: string; agent_name: string }>(
      "SELECT user_id, title, agent_name FROM agent_conversations WHERE id = $1",
      [body.conversation.id],
    );
    expect(rows[0]?.user_id).toBe("u-create");
    expect(rows[0]?.title).toBe("first");
    expect(rows[0]?.agent_name).toBe(TEST_AGENT.name);
  });

  dbTest("rejects unknown agent with 400", async (db) => {
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request("http://x/conversations?agent=nope", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "u-1" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_agent");
  });
});

describe("POST /conversations/:id/messages", () => {
  dbTest("enqueues a run tagged with conversationId on the first turn", async (db) => {
    const convId = `it-conv-route-${Date.now()}`;
    await createConversation(db, {
      id: convId,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-msg",
    });

    const { app, sentJobs } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "u-msg" },
        body: JSON.stringify({ input: "hello there" }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; conversationId: string };
    expect(body.conversationId).toBe(convId);
    expect(typeof body.runId).toBe("string");

    const runRow = await db.query<{ conversation_id: string; user_id: string }>(
      "SELECT conversation_id, user_id FROM agent_runs WHERE id = $1",
      [body.runId],
    );
    expect(runRow.rows[0]?.conversation_id).toBe(convId);
    expect(runRow.rows[0]?.user_id).toBe("u-msg");

    const msgRow = await db.query<{ conversation_id: string; n: number }>(
      "SELECT conversation_id, COUNT(*)::int AS n FROM agent_messages WHERE run_id = $1 GROUP BY conversation_id",
      [body.runId],
    );
    expect(msgRow.rows[0]?.conversation_id).toBe(convId);
    expect(msgRow.rows[0]?.n).toBe(1);

    expect(sentJobs).toHaveLength(1);
  });

  dbTest("returns 409 conversation_busy when a prior run is still active", async (db) => {
    const convId = `it-conv-busy-${Date.now()}`;
    await createConversation(db, {
      id: convId,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-busy",
    });
    // Pre-create an active run on this conversation so the next POST trips
    // the sequential-only guard.
    await createRun(db, {
      id: `${convId}-r-active`,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-busy",
      conversationId: convId,
    });

    const { app, sentJobs } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "u-busy" },
        body: JSON.stringify({ input: "second" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; activeRunId?: string };
    expect(body.error).toBe("conversation_busy");
    expect(body.activeRunId).toBe(`${convId}-r-active`);
    // Sequential guard must not enqueue.
    expect(sentJobs).toHaveLength(0);
  });

  dbTest("returns 404 when a different user tries to post into a conversation", async (db) => {
    const convId = `it-conv-cross-${Date.now()}`;
    await createConversation(db, {
      id: convId,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-owner",
    });
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "u-other" },
        body: JSON.stringify({ input: "hi" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  dbTest("rejects empty body.input with 400", async (db) => {
    const convId = `it-conv-empty-${Date.now()}`;
    await createConversation(db, {
      id: convId,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-empty",
    });
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "u-empty" },
        body: JSON.stringify({ input: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /conversations/:id/stream replay", () => {
  dbTest("replays every message in the conversation across runs", async (db) => {
    const convId = `it-conv-stream-${Date.now()}`;
    await createConversation(db, {
      id: convId,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-stream",
    });
    const r1 = `${convId}-r1`;
    await createRun(db, {
      id: r1,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-stream",
      conversationId: convId,
    });
    await appendMessage(db, {
      runId: r1,
      conversationId: convId,
      role: "user",
      content: [{ type: "text", text: "first turn user" }],
    });
    await appendMessage(db, {
      runId: r1,
      conversationId: convId,
      role: "assistant",
      content: [{ type: "text", text: "first turn assistant" }],
    });
    await setRunStatus(db, r1, "completed");

    const r2 = `${convId}-r2`;
    await createRun(db, {
      id: r2,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-stream",
      conversationId: convId,
    });
    await appendMessage(db, {
      runId: r2,
      conversationId: convId,
      role: "user",
      content: [{ type: "text", text: "second turn user" }],
    });
    await setRunStatus(db, r2, "completed");

    const { app } = buildTestApp(db);
    // The conversation stream stays open between turns by design, so we
    // can't await res.text() — that would block forever. Read chunks until
    // we've seen every expected message or a short budget elapses, then
    // cancel the reader.
    const res = await app.fetch(
      new Request(`http://x/conversations/${convId}/stream`, {
        headers: { "x-test-user": "u-stream" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;
    const decoder = new TextDecoder();
    let body = "";
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) body += decoder.decode(value, { stream: true });
      if (
        body.includes("first turn user") &&
        body.includes("first turn assistant") &&
        body.includes("second turn user")
      ) {
        break;
      }
    }
    await reader.cancel().catch(() => {});

    expect(body).toMatch(/"text":"first turn user"/);
    expect(body).toMatch(/"text":"first turn assistant"/);
    expect(body).toMatch(/"text":"second turn user"/);
  });

  dbTest("returns 404 when a different user requests the stream", async (db) => {
    const convId = `it-conv-stream-cross-${Date.now()}`;
    await createConversation(db, {
      id: convId,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-stream-owner",
    });
    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request(`http://x/conversations/${convId}/stream`, {
        headers: { "x-test-user": "u-stream-other" },
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /conversations", () => {
  dbTest("lists only the caller's conversations by default", async (db) => {
    const tag = `it-conv-list-${Date.now()}`;
    await createConversation(db, {
      id: `${tag}-mine`,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-listmine",
    });
    await createConversation(db, {
      id: `${tag}-theirs`,
      agentName: TEST_AGENT.name,
      agentVersion: TEST_AGENT.version,
      userId: "u-listother",
    });

    const { app } = buildTestApp(db);
    const res = await app.fetch(
      new Request("http://x/conversations?limit=50", {
        headers: { "x-test-user": "u-listmine" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: { id: string; userId: string }[] };
    const ids = body.conversations.map((c) => c.id);
    expect(ids).toContain(`${tag}-mine`);
    expect(ids).not.toContain(`${tag}-theirs`);
  });
});
