/**
 * Integration tests for enqueueRun — the producer surface used by the web
 * service to seed a run and hand it off to the worker. Verifies that we
 * create the agent_runs row, append the initial user message, and dispatch
 * a pg-boss job, all atomically and idempotently.
 *
 * Skipped when Postgres is unreachable, mirroring repo.integration.test.ts.
 */

import {
  applyMigrations,
  closeSharedPool,
  countRunMessages,
  createPool,
  loadRun,
  type Pool,
} from "@render-harness/core";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueRun, type RunJob } from "./index.js";

const CONN = process.env.TEST_DATABASE_URL ?? "postgres://harness:harness@127.0.0.1:55432/harness";

let pool: Pool | null = null;

beforeAll(async () => {
  try {
    pool = createPool({ connectionString: CONN, applicationName: "worker-enqueue-it" });
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
  data: RunJob;
}

function makeFakeBoss(): { boss: PgBoss; sent: SentJob[] } {
  const sent: SentJob[] = [];
  const boss = {
    send: async (queue: string, data: RunJob) => {
      sent.push({ queue, data });
      return null as unknown as string;
    },
  } as unknown as PgBoss;
  return { boss, sent };
}

describe("enqueueRun", () => {
  dbTest("creates run row, appends initial message, dispatches boss job", async (db) => {
    const { boss, sent } = makeFakeBoss();
    const runId = await enqueueRun({
      pool: db,
      boss,
      queue: "test-q",
      agentName: "tester",
      agentVersion: "1.0",
      userId: "u-enqueue",
      initialContent: [{ type: "text", text: "hello" }],
      metadata: { source: "test" },
    });
    expect(typeof runId).toBe("string");

    const run = await loadRun(db, runId);
    expect(run?.agentName).toBe("tester");
    expect(run?.agentVersion).toBe("1.0");
    expect(run?.userId).toBe("u-enqueue");
    expect(run?.metadata).toMatchObject({ runtime: "worker", source: "test" });

    expect(await countRunMessages(db, runId)).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.queue).toBe("test-q");
    expect(sent[0]?.data.runId).toBe(runId);
    expect(sent[0]?.data.agentName).toBe("tester");
    expect(sent[0]?.data.userId).toBe("u-enqueue");
  });

  dbTest("respects fixed runId option", async (db) => {
    const fixedId = `enqueue-fixed-${Date.now()}`;
    const { boss } = makeFakeBoss();
    const id = await enqueueRun({
      pool: db,
      boss,
      queue: "q",
      agentName: "x",
      agentVersion: "0",
      runId: fixedId,
    });
    expect(id).toBe(fixedId);
    const run = await loadRun(db, fixedId);
    expect(run?.id).toBe(fixedId);
  });

  dbTest("repeat with the same runId is idempotent — single row, single message", async (db) => {
    const fixedId = `enqueue-idempotent-${Date.now()}`;
    const { boss, sent } = makeFakeBoss();
    const args = {
      pool: db,
      boss,
      queue: "q",
      agentName: "x",
      agentVersion: "0",
      runId: fixedId,
      initialContent: [{ type: "text", text: "first call" }],
    } as const;

    await enqueueRun(args);
    expect(await countRunMessages(db, fixedId)).toBe(1);

    // A second producer (or a retry) using the same runId must not
    // duplicate the row or the seed message.
    await enqueueRun(args);
    expect(await countRunMessages(db, fixedId)).toBe(1);
    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agent_runs WHERE id = $1",
      [fixedId],
    );
    expect(rows[0]?.count).toBe("1");

    // Both calls still dispatched a job — pg-boss is the source of truth
    // for delivery semantics, not enqueueRun.
    expect(sent).toHaveLength(2);
  });

  dbTest("omits userId from job when not provided", async (db) => {
    const { boss, sent } = makeFakeBoss();
    await enqueueRun({
      pool: db,
      boss,
      queue: "q",
      agentName: "x",
      agentVersion: "0",
      runId: `enqueue-no-user-${Date.now()}`,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data.userId).toBeUndefined();
  });
});
