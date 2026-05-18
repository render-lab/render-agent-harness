import { describe, expect, it, vi } from "vitest";
import pack from "./index.js";

function ctx(env: Record<string, string | undefined>) {
  return {
    config: {},
    env: (name: string) => env[name],
    entryName: "test-bundle",
  };
}

describe("cap-search-tavily mcpServers", () => {
  it("registers the Tavily MCP server when the API key is set", () => {
    const servers = pack.mcpServers?.(ctx({ TAVILY_API_KEY: "k_test" }));
    expect(Array.isArray(servers)).toBe(true);
    expect(servers).toHaveLength(1);
    const [tavily] = servers as Array<{ name: string; env?: Record<string, string> }>;
    expect(tavily.name).toBe("tavily");
    expect(tavily.env?.TAVILY_API_KEY).toBe("k_test");
  });

  it("returns [] and warns instead of throwing when TAVILY_API_KEY is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const servers = pack.mcpServers?.(ctx({}));
      expect(servers).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/cap-search-tavily.*TAVILY_API_KEY.*not set/);
    } finally {
      warn.mockRestore();
    }
  });
});
