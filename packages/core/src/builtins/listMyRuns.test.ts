import { describe, expect, it, vi } from "vitest";
import { listMyRunsFactory } from "./listMyRuns.js";
import type { BuiltinContext } from "./types.js";

const noopArgs = {
  runId: "r",
  toolCallId: "c",
  signal: new AbortController().signal,
  logger: {} as never,
};

function makePool(rows: unknown[]): { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows }));
  return { query };
}

function ctxFor(opts: { userId: string | null; pool: unknown }): BuiltinContext {
  return {
    pool: opts.pool as BuiltinContext["pool"],
    userId: opts.userId,
    agentName: "test-agent",
  } as BuiltinContext;
}

describe("list_my_runs", () => {
  it("returns empty when no userId is attached", async () => {
    const pool = makePool([]);
    const reg = listMyRunsFactory(ctxFor({ userId: null, pool }));
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({ input: {}, ...noopArgs });
    expect(out.content).toMatch(/no authenticated user/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("scopes the SQL to the caller's userId and current agent by default", async () => {
    const pool = makePool([]);
    const reg = listMyRunsFactory(ctxFor({ userId: "u_42", pool }));
    if (!reg.registered) throw new Error("expected registered");
    await reg.handler.handler({ input: {}, ...noopArgs });
    expect(pool.query).toHaveBeenCalled();
    const callArgs = pool.query.mock.calls[0];
    const params = callArgs?.[1] as unknown[];
    // listRuns places userId first, then agentName as a text[]
    expect(params).toContain("u_42");
    // Agent name passed as ["test-agent"] (single-element array) — check it's present
    expect(params.some((p) => Array.isArray(p) && p.includes("test-agent"))).toBe(true);
  });

  it("honors agent='*' to span all agents", async () => {
    const pool = makePool([]);
    const reg = listMyRunsFactory(ctxFor({ userId: "u_42", pool }));
    if (!reg.registered) throw new Error("expected registered");
    await reg.handler.handler({ input: { agent: "*" }, ...noopArgs });
    const callArgs = pool.query.mock.calls[0];
    const params = callArgs?.[1] as unknown[];
    // No agent_name array param
    expect(params.some((p) => Array.isArray(p) && p.includes("test-agent"))).toBe(false);
  });

  it("formats rows compactly when results exist", async () => {
    const pool = makePool([
      {
        id: "run_1",
        agent_name: "test-agent",
        agent_version: "0.1.0",
        status: "completed",
        user_id: "u_42",
        cursor: { turn: 3, toolCalls: 2, wallMs: 1000, usage: { inputTokens: 0, outputTokens: 0 } },
        total_cost_usd: "0.0123",
        metadata: {},
        final_error: null,
        created_at: new Date("2026-05-01T00:00:00Z"),
        updated_at: new Date("2026-05-01T00:01:00Z"),
        started_at: new Date("2026-05-01T00:00:01Z"),
        finished_at: new Date("2026-05-01T00:01:00Z"),
      },
    ]);
    const reg = listMyRunsFactory(ctxFor({ userId: "u_42", pool }));
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({ input: { limit: 5 }, ...noopArgs });
    expect(out.content).toContain("id=run_1");
    expect(out.content).toContain("agent=test-agent@0.1.0");
    expect(out.content).toContain("status=completed");
    expect(out.content).toContain("turns=3");
    expect(out.content).toContain("tools=2");
  });
});
