import { describe, expect, it } from "vitest";
import { exposedToolName, parseExposedToolName } from "./mcp.js";

describe("exposedToolName / parseExposedToolName", () => {
  it("round-trips a server/tool pair", () => {
    const name = exposedToolName("render", "list_services");
    expect(name).toBe("render__list_services");
    expect(parseExposedToolName(name)).toEqual({
      server: "render",
      name: "list_services",
    });
  });

  it("sanitizes characters that aren't tool-name-safe", () => {
    const name = exposedToolName("render-mcp.v2", "list-services");
    expect(name).toBe("render_mcp_v2__list_services");
  });

  it("returns null for non-prefixed names", () => {
    expect(parseExposedToolName("plain_name")).toBeNull();
  });
});
