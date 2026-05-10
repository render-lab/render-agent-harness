import { describe, expect, it, vi } from "vitest";
import { todoFactory } from "./todo.js";
import type { BuiltinContext } from "./types.js";

interface FakePool {
  rows: { metadata?: { todos?: unknown } };
  query: ReturnType<typeof vi.fn>;
}

function makePool(initial: unknown[] = []): FakePool {
  const state: { todos?: unknown } = { todos: initial };
  const pool = {
    rows: { metadata: state },
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("metadata->'todos'")) {
        return { rows: [{ todos: state.todos }] };
      }
      if (sql.includes("UPDATE agent_runs")) {
        const patch = JSON.parse(params[1] as string) as { todos?: unknown };
        state.todos = patch.todos;
        return { rows: [] };
      }
      return { rows: [] };
    }) as never,
  };
  return pool as unknown as FakePool;
}

const noopArgs = {
  runId: "r",
  toolCallId: "c",
  signal: new AbortController().signal,
  logger: {} as never,
};

function ctxFor(pool: FakePool): BuiltinContext {
  return {
    pool: pool as unknown as BuiltinContext["pool"],
    runId: "run_t",
  } as BuiltinContext;
}

describe("todo", () => {
  it("returns '(no todos yet)' when list is empty", async () => {
    const pool = makePool([]);
    const reg = todoFactory(ctxFor(pool));
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({ input: {}, ...noopArgs });
    expect(out.content).toBe("(no todos yet)");
  });

  it("writes new items and then lists them", async () => {
    const pool = makePool([]);
    const reg = todoFactory(ctxFor(pool));
    if (!reg.registered) throw new Error("expected registered");
    const written = await reg.handler.handler({
      input: {
        todos: [
          { id: "a", content: "do a", status: "in_progress" },
          { id: "b", content: "do b", status: "pending" },
        ],
      },
      ...noopArgs,
    });
    expect(written.content).toContain("[~] a: do a");
    expect(written.content).toContain("[ ] b: do b");
  });

  it("merges by id (default)", async () => {
    const pool = makePool([]);
    const reg = todoFactory(ctxFor(pool));
    if (!reg.registered) throw new Error("expected registered");
    await reg.handler.handler({
      input: {
        todos: [
          { id: "a", content: "do a", status: "pending" },
          { id: "b", content: "do b", status: "pending" },
        ],
      },
      ...noopArgs,
    });
    const out = await reg.handler.handler({
      input: { todos: [{ id: "a", content: "do a", status: "completed" }] },
      ...noopArgs,
    });
    expect(out.content).toContain("[x] a: do a");
    expect(out.content).toContain("[ ] b: do b");
  });

  it("replaces wholesale when merge=false", async () => {
    const pool = makePool([]);
    const reg = todoFactory(ctxFor(pool));
    if (!reg.registered) throw new Error("expected registered");
    await reg.handler.handler({
      input: { todos: [{ id: "a", content: "do a", status: "pending" }] },
      ...noopArgs,
    });
    const out = await reg.handler.handler({
      input: {
        merge: false,
        todos: [{ id: "x", content: "fresh", status: "pending" }],
      },
      ...noopArgs,
    });
    expect(out.content).not.toContain("a: do a");
    expect(out.content).toContain("[ ] x: fresh");
  });

  it("rejects items with invalid status", async () => {
    const pool = makePool([]);
    const reg = todoFactory(ctxFor(pool));
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({
      input: { todos: [{ id: "a", content: "do a", status: "bogus" }] },
      ...noopArgs,
    });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/invalid status/);
  });

  it("rejects items with missing id", async () => {
    const pool = makePool([]);
    const reg = todoFactory(ctxFor(pool));
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({
      input: { todos: [{ content: "do a", status: "pending" }] },
      ...noopArgs,
    });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/non-empty `id`/);
  });
});
