import { describe, expect, it } from "vitest";
import { currentTimeFactory } from "./currentTime.js";
import type { BuiltinContext } from "./types.js";

const stubCtx = {
  env: {} as NodeJS.ProcessEnv,
} as BuiltinContext;

const noopArgs = {
  runId: "r",
  toolCallId: "c",
  signal: new AbortController().signal,
  logger: {} as never,
};

describe("current_time", () => {
  it("returns ISO-8601 UTC by default", async () => {
    const reg = currentTimeFactory(stubCtx);
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({ input: {}, ...noopArgs });
    const parsed = JSON.parse(out.content) as { utc: string };
    expect(parsed.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(out.isError).toBeFalsy();
  });

  it("includes local time and offset when given a valid IANA timezone", async () => {
    const reg = currentTimeFactory(stubCtx);
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({
      input: { timezone: "Asia/Tokyo" },
      ...noopArgs,
    });
    const parsed = JSON.parse(out.content) as { utc: string; timezone: string; local: string };
    expect(parsed.timezone).toBe("Asia/Tokyo");
    // Tokyo is +09:00 year-round.
    expect(parsed.local).toMatch(/\+09:00$/);
  });

  it("rejects an invalid IANA timezone", async () => {
    const reg = currentTimeFactory(stubCtx);
    if (!reg.registered) throw new Error("expected registered");
    const out = await reg.handler.handler({
      input: { timezone: "Not/A_Zone" },
      ...noopArgs,
    });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/not a valid IANA timezone/);
  });
});
