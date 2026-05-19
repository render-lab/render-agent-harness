import { existsSync } from "node:fs";
import { exposedToolName } from "@render-harness/core";
import { namespacedMcpServerName } from "@render-harness/registry";
import { describe, expect, it, vi } from "vitest";
import pack, { RENDER_MCP_MUTATING_TOOL_NAMES_RAW, RENDER_MCP_MUTATING_TOOLS } from "./index.js";

function ctx(env: Record<string, string | undefined>, config: Record<string, unknown> = {}) {
  return {
    config,
    env: (name: string) => env[name],
    entryName: "test-bundle",
  };
}

describe("cap-render mcpServers", () => {
  it("registers the Render MCP with bearer auth when RENDER_API_KEY is set", () => {
    const servers = pack.mcpServers?.(ctx({ RENDER_API_KEY: "rnd_test_token" }));
    expect(Array.isArray(servers)).toBe(true);
    expect(servers).toHaveLength(1);
    const [render] = servers as Array<{
      name: string;
      transport: string;
      url: string;
      headers: Record<string, string>;
    }>;
    expect(render.name).toBe("render");
    expect(render.transport).toBe("http");
    expect(render.url).toBe("https://mcp.render.com/mcp");
    expect(render.headers.Authorization).toBe("Bearer rnd_test_token");
  });

  it("honors the apiKeyEnv config override", () => {
    const servers = pack.mcpServers?.(
      ctx({ MY_RENDER_TOKEN: "rnd_override" }, { apiKeyEnv: "MY_RENDER_TOKEN" }),
    );
    expect(servers).toHaveLength(1);
    const [render] = servers as Array<{ headers: Record<string, string> }>;
    expect(render.headers.Authorization).toBe("Bearer rnd_override");
  });

  it("honors the baseUrl config override (for staging or self-hosted MCP)", () => {
    const servers = pack.mcpServers?.(
      ctx({ RENDER_API_KEY: "rnd_test_token" }, { baseUrl: "https://mcp.staging.render.com/mcp" }),
    );
    expect(servers).toHaveLength(1);
    const [render] = servers as Array<{ url: string }>;
    expect(render.url).toBe("https://mcp.staging.render.com/mcp");
  });

  it("returns [] and warns instead of throwing when RENDER_API_KEY is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const servers = pack.mcpServers?.(ctx({}));
      expect(servers).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/cap-render.*RENDER_API_KEY.*not set/);
    } finally {
      warn.mockRestore();
    }
  });

  it("respects apiKeyEnv override when surfacing the missing-env warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const servers = pack.mcpServers?.(ctx({}, { apiKeyEnv: "CUSTOM_RENDER_KEY" }));
      expect(servers).toEqual([]);
      expect(warn.mock.calls[0]?.[0]).toMatch(/CUSTOM_RENDER_KEY/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("cap-render skills", () => {
  it("contributes three skill entries with reachable contentPath files", () => {
    const skills = pack.skills?.(ctx({}));
    expect(skills).toHaveLength(3);
    const names = skills?.map((s) => s.name) ?? [];
    expect(names).toEqual(["render-overview", "render-deploy-flow", "render-logs-and-debug"]);
    for (const skill of skills ?? []) {
      expect(skill.contentPath).toMatch(/cap-render\/skills\/.+\.md$/);
      expect(skill.description).toBeTruthy();
      expect(skill.whenToUse).toBeTruthy();
      // The skill files must actually exist on disk — the runtime
      // load_skill builtin reads contentPath, so a typo here would
      // surface as a 404-at-call-time bug otherwise.
      expect(existsSync(skill.contentPath)).toBe(true);
    }
  });
});

describe("RENDER_MCP_MUTATING_TOOLS (exposed names for permissions.requireApproval)", () => {
  it("lists 12 destructive Render MCP tools", () => {
    expect(RENDER_MCP_MUTATING_TOOLS).toHaveLength(12);
    expect(RENDER_MCP_MUTATING_TOOL_NAMES_RAW).toHaveLength(12);
  });

  it("only contains cap_render__render__ prefixed names (matches loader+core namespacing)", () => {
    for (const tool of RENDER_MCP_MUTATING_TOOLS) {
      expect(tool).toMatch(/^cap_render__render__/);
    }
  });

  it("includes the three primary resource families (service, postgres, keyvalue) + env vars", () => {
    const list = RENDER_MCP_MUTATING_TOOLS as readonly string[];
    expect(list.some((t) => t.includes("service"))).toBe(true);
    expect(list.some((t) => t.includes("postgres"))).toBe(true);
    expect(list.some((t) => t.includes("keyvalue"))).toBe(true);
    expect(list.some((t) => t.includes("environment_variable"))).toBe(true);
  });

  it("each exposed name is exactly what the runtime namespacing chain produces", () => {
    // This is the actual integration test for the constant. If
    // either namespacedMcpServerName or exposedToolName ever changes
    // their sanitization rules, this test fails and forces us to
    // update the constant — that's the whole point of pinning it.
    const packServerName = namespacedMcpServerName("cap-render", "render");
    expect(packServerName).toBe("cap-render__render");
    for (let i = 0; i < RENDER_MCP_MUTATING_TOOL_NAMES_RAW.length; i++) {
      const rawTool = RENDER_MCP_MUTATING_TOOL_NAMES_RAW[i];
      const expected = exposedToolName(packServerName, rawTool ?? "");
      expect(RENDER_MCP_MUTATING_TOOLS[i]).toBe(expected);
    }
  });

  it("RENDER_MCP_MUTATING_TOOL_NAMES_RAW matches what Render's MCP returns from tools/list (snapshot)", () => {
    // Snapshot for accidental drift. If Render's MCP catalog grows
    // new mutating tools, update both this expectation and the
    // RENDER_MCP_MUTATING_TOOL_NAMES_RAW constant.
    expect([...RENDER_MCP_MUTATING_TOOL_NAMES_RAW].sort()).toEqual(
      [
        "create_environment_variable",
        "create_keyvalue",
        "create_postgres",
        "create_web_service",
        "delete_environment_variable",
        "delete_keyvalue",
        "delete_postgres",
        "delete_service",
        "update_environment_variables",
        "update_keyvalue",
        "update_postgres",
        "update_web_service",
      ].sort(),
    );
  });
});

describe("cap-render pack metadata", () => {
  it("uses the pack name 'cap-render' (matches the namespacing the loader applies)", () => {
    expect(pack.name).toBe("cap-render");
  });

  it("declares RENDER_API_KEY in envSchema as a required secret", () => {
    expect(pack.envSchema).toHaveLength(1);
    const [entry] = pack.envSchema ?? [];
    expect(entry?.name).toBe("RENDER_API_KEY");
    expect(entry?.required).toBe(true);
    expect(entry?.secret).toBe(true);
  });
});
