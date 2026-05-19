import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pack, { NOTION_PROVIDER_ID, notionProvider } from "./index.js";

function ctx(config: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  return {
    config,
    env: (name: string) => env[name],
    entryName: "test-bundle",
  };
}

describe("cap-notion pack metadata", () => {
  it("declares env schema for OAuth client id/secret + encryption key", () => {
    const names = (pack.envSchema ?? []).map((e) => e.name).sort();
    expect(names).toEqual(
      ["CONNECTIONS_ENCRYPTION_KEY", "NOTION_OAUTH_CLIENT_ID", "NOTION_OAUTH_CLIENT_SECRET"].sort(),
    );
  });

  it("marks client_id as non-secret and client_secret + key as secret", () => {
    const schema = pack.envSchema ?? [];
    expect(schema.find((e) => e.name === "NOTION_OAUTH_CLIENT_ID")?.secret).toBe(false);
    expect(schema.find((e) => e.name === "NOTION_OAUTH_CLIENT_SECRET")?.secret).toBe(true);
    expect(schema.find((e) => e.name === "CONNECTIONS_ENCRYPTION_KEY")?.secret).toBe(true);
  });

  it("declares connectionsRequired for the notion provider", () => {
    expect(pack.connectionsRequired).toEqual([{ provider: NOTION_PROVIDER_ID, scopes: [] }]);
  });
});

describe("cap-notion OAuth provider", () => {
  it("registers exactly one provider (notion) at default env names", () => {
    const providers = pack.oauthProviders?.(ctx({}));
    expect(providers).toHaveLength(1);
    const [p] = providers ?? [];
    expect(p?.id).toBe("notion");
    expect(p?.displayName).toBe("Notion");
    expect(p?.clientIdEnv).toBe("NOTION_OAUTH_CLIENT_ID");
    expect(p?.clientSecretEnv).toBe("NOTION_OAUTH_CLIENT_SECRET");
    expect(p?.refreshTokenOptional).toBe(true);
  });

  it("honors clientIdEnv / clientSecretEnv config overrides", () => {
    const providers = pack.oauthProviders?.(
      ctx({ clientIdEnv: "MY_NOTION_ID", clientSecretEnv: "MY_NOTION_SECRET" }),
    );
    const [p] = providers ?? [];
    expect(p?.clientIdEnv).toBe("MY_NOTION_ID");
    expect(p?.clientSecretEnv).toBe("MY_NOTION_SECRET");
  });

  it("uses the Notion API authorize/token URLs and `owner: user` extra param", () => {
    const p = notionProvider();
    expect(p.authorizeUrl).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(p.tokenUrl).toBe("https://api.notion.com/v1/oauth/token");
    expect(p.extraAuthorizeParams).toEqual({ owner: "user" });
  });
});

describe("cap-notion tool surface", () => {
  it("ships 8 tools in read_write mode (search + 4 page + 3 database)", () => {
    const tools = pack.localTools?.(ctx({ accessMode: "read_write" }));
    expect(tools).toHaveLength(8);
    const names = (tools ?? []).map((t) => t.definition.name).sort();
    expect(names).toEqual(
      [
        "search",
        "read_page",
        "create_page",
        "append_blocks",
        "update_page_properties",
        "query_database",
        "create_database_row",
        "update_database_row",
      ].sort(),
    );
  });

  it("ships 3 tools in read mode (search + read_page + query_database only)", () => {
    const tools = pack.localTools?.(ctx({ accessMode: "read" }));
    const names = (tools ?? []).map((t) => t.definition.name).sort();
    expect(names).toEqual(["query_database", "read_page", "search"].sort());
  });

  it("defaults to read_write when accessMode is unset or garbage", () => {
    expect(pack.localTools?.(ctx({}))).toHaveLength(8);
    expect(pack.localTools?.(ctx({ accessMode: "not-a-mode" }))).toHaveLength(8);
  });

  it("every tool's source is namespaced under pack:cap-notion", () => {
    const tools = pack.localTools?.(ctx({ accessMode: "read_write" })) ?? [];
    for (const t of tools) {
      expect(t.definition.source).toBe("pack:cap-notion");
    }
  });
});

describe("cap-notion skills", () => {
  it("ships two skills with reachable contentPath files", () => {
    const skills = pack.skills?.(ctx({})) ?? [];
    const names = skills.map((s) => s.name);
    expect(names).toEqual(["notion-pages", "notion-databases"]);
    for (const skill of skills) {
      expect(existsSync(skill.contentPath)).toBe(true);
    }
  });
});

describe("cap-notion error handling (no SecretsContext)", () => {
  it("search returns isError when SecretsContext is missing", async () => {
    const tools = pack.localTools?.(ctx({})) ?? [];
    const search = tools.find((t) => t.definition.name === "search");
    if (!search) throw new Error("search tool missing");
    const result = await search.handler({
      input: { query: "anything" },
      runId: "test" as never,
      toolCallId: "tc" as never,
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
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/SecretsContext/);
  });
});
