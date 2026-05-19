import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pack, { assembleFigmaScopes, FIGMA_PROVIDER_ID, figmaProvider } from "./index.js";

function ctx(config: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  return {
    config,
    env: (name: string) => env[name],
    entryName: "test-bundle",
  };
}

describe("cap-figma pack metadata", () => {
  it("declares env schema for OAuth client id/secret + encryption key", () => {
    const names = (pack.envSchema ?? []).map((e) => e.name).sort();
    expect(names).toEqual(
      ["CONNECTIONS_ENCRYPTION_KEY", "FIGMA_OAUTH_CLIENT_ID", "FIGMA_OAUTH_CLIENT_SECRET"].sort(),
    );
  });

  it("marks client id as non-secret; client secret + key as secret", () => {
    const schema = pack.envSchema ?? [];
    expect(schema.find((e) => e.name === "FIGMA_OAUTH_CLIENT_ID")?.secret).toBe(false);
    expect(schema.find((e) => e.name === "FIGMA_OAUTH_CLIENT_SECRET")?.secret).toBe(true);
    expect(schema.find((e) => e.name === "CONNECTIONS_ENCRYPTION_KEY")?.secret).toBe(true);
  });

  it("declares connectionsRequired for the figma provider", () => {
    expect(pack.connectionsRequired?.[0]?.provider).toBe(FIGMA_PROVIDER_ID);
  });
});

describe("assembleFigmaScopes (granular per-action scopes)", () => {
  it("read mode requests 4 scopes: content + metadata + comments(read) + current_user", () => {
    const scopes = assembleFigmaScopes("read");
    expect(scopes).toEqual([
      "file_content:read",
      "file_metadata:read",
      "file_comments:read",
      "current_user:read",
    ]);
    expect(scopes).toHaveLength(4);
  });

  it("read_write_comments mode adds file_comments:write (5 total)", () => {
    const scopes = assembleFigmaScopes("read_write_comments");
    expect(scopes).toHaveLength(5);
    expect(scopes).toContain("file_comments:write");
    expect(scopes).toContain("file_content:read");
  });

  it("uses only the new granular scope strings, never the deprecated coarse files:read", () => {
    const read = assembleFigmaScopes("read");
    const rwc = assembleFigmaScopes("read_write_comments");
    for (const s of [...read, ...rwc]) {
      expect(s).not.toBe("files:read");
      expect(s).not.toBe("file_read");
      // every granular scope follows the action-style format "X:Y" or "current_user:read"
      expect(s).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });
});

describe("cap-figma OAuth provider", () => {
  it("registers one provider at the Figma OAuth URLs in read_write_comments by default", () => {
    const providers = pack.oauthProviders?.(ctx({}));
    expect(providers).toHaveLength(1);
    const p = providers?.[0];
    if (!p) throw new Error("no provider");
    expect(p.id).toBe("figma");
    expect(p.displayName).toBe("Figma");
    expect(p.authorizeUrl).toBe("https://www.figma.com/oauth");
    expect(p.tokenUrl).toBe("https://api.figma.com/v1/oauth/token");
    expect(p.defaultScopes).toContain("file_comments:write");
  });

  it("read mode drops file_comments:write from the OAuth scope set", () => {
    const providers = pack.oauthProviders?.(ctx({ accessMode: "read" }));
    const p = providers?.[0];
    expect(p?.defaultScopes).not.toContain("file_comments:write");
    expect(p?.defaultScopes).toContain("file_comments:read");
  });

  it("honors clientIdEnv / clientSecretEnv config overrides", () => {
    const providers = pack.oauthProviders?.(
      ctx({ clientIdEnv: "MY_FIG_ID", clientSecretEnv: "MY_FIG_SECRET" }),
    );
    const p = providers?.[0];
    expect(p?.clientIdEnv).toBe("MY_FIG_ID");
    expect(p?.clientSecretEnv).toBe("MY_FIG_SECRET");
  });

  it("exports figmaProvider directly for ops tooling", () => {
    const p = figmaProvider({ accessMode: "read" });
    expect(p.defaultScopes).toHaveLength(4);
  });
});

describe("cap-figma tool surface", () => {
  it("ships 7 tools in read_write_comments mode", () => {
    const tools = pack.localTools?.(ctx({}));
    expect(tools).toHaveLength(7);
    const names = (tools ?? []).map((t) => t.definition.name).sort();
    expect(names).toEqual(
      [
        "read_file",
        "read_file_nodes",
        "read_file_metadata",
        "list_team_projects",
        "list_project_files",
        "read_comments",
        "post_comment",
      ].sort(),
    );
  });

  it("ships 6 tools in read mode (drops post_comment)", () => {
    const tools = pack.localTools?.(ctx({ accessMode: "read" }));
    const names = (tools ?? []).map((t) => t.definition.name);
    expect(names).toHaveLength(6);
    expect(names).not.toContain("post_comment");
  });

  it("every tool is namespaced under pack:cap-figma", () => {
    const tools = pack.localTools?.(ctx({})) ?? [];
    for (const t of tools) {
      expect(t.definition.source).toBe("pack:cap-figma");
    }
  });
});

describe("cap-figma skills", () => {
  it("ships figma-files and figma-comments skills with reachable contentPath files", () => {
    const skills = pack.skills?.(ctx({})) ?? [];
    const names = skills.map((s) => s.name);
    expect(names).toEqual(["figma-files", "figma-comments"]);
    for (const s of skills) {
      expect(existsSync(s.contentPath)).toBe(true);
    }
  });
});

describe("cap-figma tool error paths", () => {
  it("read_file returns isError without SecretsContext", async () => {
    const tools = pack.localTools?.(ctx({})) ?? [];
    const t = tools.find((tool) => tool.definition.name === "read_file");
    if (!t) throw new Error("read_file missing");
    const res = await t.handler({
      input: { file_key: "abc" },
      runId: "r" as never,
      toolCallId: "c" as never,
      signal: new AbortController().signal,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
        child() {
          return this;
        },
      } as never,
    } as never);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/SecretsContext/);
  });

  it("post_comment requires file_key and message", async () => {
    const tools = pack.localTools?.(ctx({})) ?? [];
    const t = tools.find((tool) => tool.definition.name === "post_comment");
    if (!t) throw new Error("post_comment missing");
    const res = await t.handler({
      input: { file_key: "" },
      runId: "r" as never,
      toolCallId: "c" as never,
      signal: new AbortController().signal,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
        child() {
          return this;
        },
      } as never,
    } as never);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/required/);
  });
});

describe("formatFigmaError (scope-drift hint)", () => {
  it("rewrites 403 into the connection-reconnect guidance", async () => {
    const { formatFigmaError } = await import("./lib.js");
    const err = Object.assign(new Error("x"), { status: 403, figmaMessage: "forbidden" });
    const out = formatFigmaError("figma.post_comment", "post comment", err);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/post comment/);
    expect(out.content).toMatch(/Disconnect Figma|Connections tab|accessMode/);
  });

  it("rewrites 401 into a reconnect guidance", async () => {
    const { formatFigmaError } = await import("./lib.js");
    const err = Object.assign(new Error("x"), { status: 401 });
    const out = formatFigmaError("figma.read_file", "read file content", err);
    expect(out.content).toMatch(/reconnect/i);
  });

  it("passes 500 through with status + figmaMessage", async () => {
    const { formatFigmaError } = await import("./lib.js");
    const err = Object.assign(new Error("x"), { status: 500, figmaMessage: "boom" });
    const out = formatFigmaError("figma.read_file", "read file content", err);
    expect(out.content).toMatch(/500/);
    expect(out.content).toMatch(/boom/);
  });
});
