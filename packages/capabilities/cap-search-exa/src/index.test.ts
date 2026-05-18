import { describe, expect, it, vi } from "vitest";
import pack from "./index.js";

function ctx(env: Record<string, string | undefined>) {
  return {
    config: {},
    env: (name: string) => env[name],
    entryName: "test-bundle",
  };
}

describe("cap-search-exa mcpServers", () => {
  it("registers the Exa MCP server when the API key is set", () => {
    const servers = pack.mcpServers?.(ctx({ EXA_API_KEY: "k_test" }));
    expect(Array.isArray(servers)).toBe(true);
    expect(servers).toHaveLength(1);
    const [exa] = servers as Array<{
      name: string;
      transport: string;
      headers: Record<string, string>;
    }>;
    expect(exa.name).toBe("exa");
    expect(exa.transport).toBe("http");
    expect(exa.headers.Authorization).toBe("Bearer k_test");
  });

  it("returns [] and warns instead of throwing when EXA_API_KEY is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const servers = pack.mcpServers?.(ctx({}));
      expect(servers).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/cap-search-exa.*EXA_API_KEY.*not set/);
    } finally {
      warn.mockRestore();
    }
  });
});
