/**
 * Integration tests for the state repo against a live Postgres.
 *
 * These tests require a Postgres reachable at TEST_DATABASE_URL or the local
 * Compose stack default. They are skipped automatically when no database
 * answers the connection. Use `pnpm db:up` to bring the stack up locally.
 */

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunCursor } from "../types.js";
import { closeSharedPool, createPool } from "./db.js";
import {
  aggregateUsage,
  appendMessage,
  countRunMessages,
  createRun,
  ensureInitialMessage,
  ensureRun,
  listRuns,
  listToolCalls,
  loadRun,
  loadToolResult,
  recordToolCall,
  recordToolResult,
  setRunStatus,
  setToolCallStatus,
  updateRunCursor,
} from "./repo.js";
import { applyMigrations } from "./schema.js";

const CONN = process.env.TEST_DATABASE_URL ?? "postgres://harness:harness@127.0.0.1:55432/harness";

let pool: Pool | null = null;

beforeAll(async () => {
  try {
    pool = createPool({ connectionString: CONN, applicationName: "repo-it" });
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
    const db = pool;
    if (!db) {
      console.warn(`[skip] ${name}: no Postgres reachable at ${CONN}`);
      return;
    }
    await fn(db);
  });
};

describe("repo integration: setRunStatus", () => {
  dbTest("transitions through running and completed without coalesce errors", async (db) => {
    const id = `it-status-${Date.now()}`;
    const created = await createRun(db, {
      id,
      agentName: "it",
      agentVersion: "0.0.0",
      metadata: { kind: "integration" },
    });
    expect(created.status).toBe("pending");
    expect(created.startedAt).toBeUndefined();

    await setRunStatus(db, id, "running");
    let row = await loadRun(db, id);
    expect(row?.status).toBe("running");
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.finishedAt).toBeUndefined();

    await setRunStatus(db, id, "completed");
    row = await loadRun(db, id);
    expect(row?.status).toBe("completed");
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  dbTest("records final_error on failed transition", async (db) => {
    const id = `it-status-fail-${Date.now()}`;
    await createRun(db, { id, agentName: "it", agentVersion: "0.0.0" });
    await setRunStatus(db, id, "failed", {
      error: { name: "Boom", message: "kaboom", code: "test" },
    });
    const { rows } = await db.query<{ final_error: { name: string } | null }>(
      "SELECT final_error FROM agent_runs WHERE id = $1",
      [id],
    );
    expect(rows[0]?.final_error?.name).toBe("Boom");
  });
});

describe("repo integration: ensureRun + ensureInitialMessage", () => {
  dbTest("ensureRun is idempotent and concurrency-safe", async (db) => {
    const id = `it-ensure-${Date.now()}`;
    const args = {
      id,
      agentName: "it",
      agentVersion: "0.0.0",
      metadata: { kind: "ensure" },
    } as const;

    const first = await ensureRun(db, args);
    expect(first.id).toBe(id);
    expect(first.status).toBe("pending");
    expect(first.metadata).toMatchObject({ kind: "ensure" });

    // Concurrent racing inserts on the same id should all return the same row,
    // and only one INSERT should ultimately happen.
    const racers = await Promise.all([
      ensureRun(db, args),
      ensureRun(db, args),
      ensureRun(db, args),
    ]);
    for (const r of racers) {
      expect(r.id).toBe(id);
      expect(r.createdAt.getTime()).toBe(first.createdAt.getTime());
    }
    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agent_runs WHERE id = $1",
      [id],
    );
    expect(rows[0]?.count).toBe("1");
  });

  dbTest("ensureInitialMessage appends once and is a no-op afterwards", async (db) => {
    const id = `it-init-msg-${Date.now()}`;
    await ensureRun(db, { id, agentName: "it", agentVersion: "0.0.0" });
    expect(await countRunMessages(db, id)).toBe(0);

    await ensureInitialMessage(db, { runId: id, content: [{ type: "text", text: "hi" }] });
    expect(await countRunMessages(db, id)).toBe(1);

    await ensureInitialMessage(db, { runId: id, content: [{ type: "text", text: "again" }] });
    expect(await countRunMessages(db, id)).toBe(1);
  });
});

describe("repo integration: tool call lifecycle", () => {
  dbTest("records and dedupes tool calls + persists results", async (db) => {
    const runId = `it-tool-${Date.now()}`;
    await createRun(db, { id: runId, agentName: "it", agentVersion: "0.0.0" });

    const tcId = `tc-${Date.now()}`;
    const idem = `idem-${tcId}`;
    const first = await recordToolCall(db, {
      id: tcId,
      runId,
      name: "noop",
      input: { foo: "bar" },
      idempotencyKey: idem,
    });
    expect(first.inserted).toBe(true);

    // Second insert with the same idempotency key should be a no-op.
    const second = await recordToolCall(db, {
      id: `${tcId}-dup`,
      runId,
      name: "noop",
      input: { foo: "bar" },
      idempotencyKey: idem,
    });
    expect(second.inserted).toBe(false);

    await setToolCallStatus(db, tcId, "running");
    await recordToolResult(db, {
      toolCallId: tcId,
      runId,
      content: "ok",
      truncatedContent: "ok",
      tokenCount: 1,
      isError: false,
      durationMs: 12,
    });
    const result = await loadToolResult(db, tcId);
    expect(result?.content).toBe("ok");
  });
});

describe("repo integration: read-side aggregations (operator UI)", () => {
  dbTest("listRuns paginates newest-first with keyset cursor", async (db) => {
    const tag = `it-list-${Date.now()}`;
    for (let i = 0; i < 4; i++) {
      await createRun(db, {
        id: `${tag}-${i}`,
        agentName: tag,
        agentVersion: "0.0.0",
      });
    }
    const first = await listRuns(db, { agentName: tag, limit: 2 });
    expect(first.runs).toHaveLength(2);
    expect(first.runs[0]?.id).toBe(`${tag}-3`);
    expect(first.runs[1]?.id).toBe(`${tag}-2`);
    expect(first.nextCursor).not.toBeNull();

    const second = await listRuns(db, {
      agentName: tag,
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.runs.map((r) => r.id)).toEqual([`${tag}-1`, `${tag}-0`]);
    expect(second.nextCursor).toBeNull();
  });

  dbTest("listToolCalls returns calls joined to results in order", async (db) => {
    const runId = `it-tc-list-${Date.now()}`;
    await createRun(db, { id: runId, agentName: "it", agentVersion: "0.0.0" });
    const idA = `${runId}-a`;
    const idB = `${runId}-b`;
    await recordToolCall(db, {
      id: idA,
      runId,
      name: "first",
      input: { x: 1 },
      idempotencyKey: `${runId}-a`,
    });
    await recordToolCall(db, {
      id: idB,
      runId,
      name: "second",
      input: { x: 2 },
      idempotencyKey: `${runId}-b`,
    });
    await recordToolResult(db, {
      toolCallId: idA,
      runId,
      content: "result-a",
      truncatedContent: "result-a",
      tokenCount: 2,
      isError: false,
      durationMs: 7,
    });

    const calls = await listToolCalls(db, runId);
    expect(calls.map((c) => c.call.name)).toEqual(["first", "second"]);
    expect(calls[0]?.result?.content).toBe("result-a");
    expect(calls[1]?.result).toBeNull();
  });

  dbTest("aggregateUsage rolls up runs by day and agent", async (db) => {
    const tag = `it-usage-${Date.now()}`;
    const a = `${tag}-A`;
    const b = `${tag}-B`;
    await createRun(db, { id: a, agentName: tag, agentVersion: "0.0.0" });
    await createRun(db, { id: b, agentName: tag, agentVersion: "0.0.0" });
    await updateRunCursor(
      db,
      a,
      { turn: 1, toolCalls: 0, wallMs: 0, usage: { inputTokens: 10, outputTokens: 5 } },
      0.01,
    );
    await updateRunCursor(
      db,
      b,
      { turn: 1, toolCalls: 0, wallMs: 0, usage: { inputTokens: 4, outputTokens: 2 } },
      0.02,
    );

    const rollups = await aggregateUsage(db, {
      from: new Date(Date.now() - 60 * 60 * 1000),
    });
    const me = rollups.find((r) => r.agentName === tag);
    expect(me?.runs).toBe(2);
    expect(me?.inputTokens).toBe(14);
    expect(me?.outputTokens).toBe(7);
    expect(me?.costUsd).toBeCloseTo(0.03, 5);
  });
});

describe("repo integration: messages and cursor", () => {
  dbTest("appendMessage assigns monotonic seq and updateRunCursor persists usage", async (db) => {
    const runId = `it-msg-${Date.now()}`;
    await createRun(db, { id: runId, agentName: "it", agentVersion: "0.0.0" });
    const m1 = await appendMessage(db, {
      runId,
      role: "user",
      content: [{ type: "text", text: "first" }],
    });
    const m2 = await appendMessage(db, {
      runId,
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    });
    expect(m1.id).not.toBe(m2.id);

    const cursor: RunCursor = {
      turn: 1,
      toolCalls: 0,
      wallMs: 1234,
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    await updateRunCursor(db, runId, cursor, 0.0042);
    const run = await loadRun(db, runId);
    expect(run?.cursor.turn).toBe(1);
    expect(run?.cursor.usage.inputTokens).toBe(100);
    expect(run?.totalCostUsd).toBeCloseTo(0.0042, 5);
  });
});
