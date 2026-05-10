import { describe, expect, it } from "vitest";
import { AwaitingInputError, askUserFactory } from "./askUser.js";
import type { BuiltinContext } from "./types.js";

const noopArgs = {
  runId: "r",
  toolCallId: "c",
  signal: new AbortController().signal,
  logger: {} as never,
};

describe("ask_user", () => {
  it("throws AwaitingInputError carrying the question", async () => {
    const reg = askUserFactory({} as BuiltinContext);
    if (!reg.registered) throw new Error("expected registered");
    await expect(
      reg.handler.handler({ input: { question: "Which option?" }, ...noopArgs }),
    ).rejects.toThrow(AwaitingInputError);
  });

  it("includes options in the error payload when provided", async () => {
    const reg = askUserFactory({} as BuiltinContext);
    if (!reg.registered) throw new Error("expected registered");
    try {
      await reg.handler.handler({
        input: { question: "Pick one", options: ["a", "b", "c"] },
        ...noopArgs,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AwaitingInputError);
      const e = err as AwaitingInputError;
      expect(e.payload.question).toBe("Pick one");
      expect(e.payload.options).toEqual(["a", "b", "c"]);
    }
  });

  it("returns an error result when question is missing", async () => {
    const reg = askUserFactory({} as BuiltinContext);
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({ input: {}, ...noopArgs });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/missing `question`/);
  });
});
