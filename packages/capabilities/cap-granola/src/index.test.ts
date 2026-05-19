import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import pack from "./index.js";

function ctx(config: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  return {
    config,
    env: (name: string) => env[name],
    entryName: "test-bundle",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cap-granola pack metadata", () => {
  it("declares the GRANOLA_API_KEY and GRANOLA_KEY_TYPE env entries", () => {
    const names = (pack.envSchema ?? []).map((e) => e.name).sort();
    expect(names).toEqual(["GRANOLA_API_KEY", "GRANOLA_KEY_TYPE"]);
  });

  it("marks API key as required secret; key type as optional non-secret", () => {
    const schema = pack.envSchema ?? [];
    const apiKey = schema.find((e) => e.name === "GRANOLA_API_KEY");
    const keyType = schema.find((e) => e.name === "GRANOLA_KEY_TYPE");
    expect(apiKey?.required).toBe(true);
    expect(apiKey?.secret).toBe(true);
    expect(keyType?.required).toBe(false);
    expect(keyType?.secret).toBe(false);
  });
});

describe("cap-granola migrations slot", () => {
  it("contributes one migration creating granola_seen_notes", () => {
    const migrations = pack.migrations?.(ctx({}));
    expect(migrations).toHaveLength(1);
    expect(migrations?.[0]?.id).toBe("0001_seen_notes");
    expect(migrations?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS granola_seen_notes");
    expect(migrations?.[0]?.sql).toContain("note_id text PRIMARY KEY");
  });
});

describe("cap-granola localTools", () => {
  it("returns the three tools when GRANOLA_API_KEY is set", () => {
    const tools = pack.localTools?.(ctx({}, { GRANOLA_API_KEY: "key_test" }));
    expect(tools).toHaveLength(3);
    const names = (tools ?? []).map((t) => t.definition.name).sort();
    expect(names).toEqual(["list_notes", "poll_recent", "read_note"]);
  });

  it("returns [] and warns instead of throwing when GRANOLA_API_KEY is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = pack.localTools?.(ctx({}, {}));
      expect(tools).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/cap-granola.*GRANOLA_API_KEY.*not set/);
    } finally {
      warn.mockRestore();
    }
  });

  it("honors apiKeyEnv config override when surfacing missing-env warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = pack.localTools?.(ctx({ apiKeyEnv: "MY_GRANOLA_KEY" }, {}));
      expect(tools).toEqual([]);
      expect(warn.mock.calls[0]?.[0]).toMatch(/MY_GRANOLA_KEY/);
    } finally {
      warn.mockRestore();
    }
  });

  it("every tool's source is namespaced under pack:cap-granola", () => {
    const tools = pack.localTools?.(ctx({}, { GRANOLA_API_KEY: "key_test" })) ?? [];
    for (const t of tools) {
      expect(t.definition.source).toBe("pack:cap-granola");
    }
  });
});

describe("cap-granola skills", () => {
  it("ships the granola-notes skill with a reachable contentPath", () => {
    const skills = pack.skills?.(ctx({})) ?? [];
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("granola-notes");
    expect(existsSync(skills[0]?.contentPath ?? "")).toBe(true);
  });
});
