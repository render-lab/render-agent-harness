import { describe, expect, it } from "vitest";
import {
  cancelKey,
  clearCancel,
  createCancelSignal,
  isCancelled,
  requestCancel,
} from "./cancel.js";
import { memoryKv } from "./kv.js";

describe("cancelKey", () => {
  it("namespaces the run id", () => {
    expect(cancelKey("abc-123")).toBe("cancel:abc-123");
  });
});

describe("createCancelSignal", () => {
  it("aborts when the upstream signal aborts", async () => {
    const kv = memoryKv();
    const upstream = new AbortController();
    const c = createCancelSignal({ runId: "r1", upstream: upstream.signal, kv });
    expect(c.signal.aborted).toBe(false);
    upstream.abort();
    expect(c.signal.aborted).toBe(true);
    c.dispose();
  });

  it("aborts when the KV cancel flag is set", async () => {
    const kv = memoryKv();
    const upstream = new AbortController();
    const c = createCancelSignal({
      runId: "r2",
      upstream: upstream.signal,
      kv,
      pollIntervalMs: 10,
    });
    expect(c.signal.aborted).toBe(false);
    await requestCancel(kv, "r2");
    await new Promise((r) => setTimeout(r, 30));
    expect(c.signal.aborted).toBe(true);
    expect(c.cancelled()).toBe(true);
    c.dispose();
  });
});

describe("isCancelled / requestCancel / clearCancel", () => {
  it("round-trips a cancel flag", async () => {
    const kv = memoryKv();
    expect(await isCancelled(kv, "r3")).toBe(false);
    await requestCancel(kv, "r3", "user_clicked_stop");
    expect(await isCancelled(kv, "r3")).toBe(true);
    await clearCancel(kv, "r3");
    expect(await isCancelled(kv, "r3")).toBe(false);
  });
});
