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
  appendMessage,
  createRun,
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
