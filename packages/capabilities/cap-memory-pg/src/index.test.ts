import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pack, { defaultEmbeddingProviderKeyEnv } from "./index.js";

function ctx(config: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  return {
    config,
    env: (name: string) => env[name],
    entryName: "test-bundle",
  };
}

describe("cap-memory-pg pack metadata", () => {
  it("declares envSchema entries for every embedding provider + override", () => {
    const names = (pack.envSchema ?? []).map((e) => e.name).sort();
    expect(names).toEqual(
      ["COHERE_API_KEY", "HARNESS_EMBEDDING_PROVIDER", "OPENAI_API_KEY", "VOYAGE_API_KEY"].sort(),
    );
  });

  it("marks API keys as secret and the override as non-secret", () => {
    const schema = pack.envSchema ?? [];
    for (const key of ["OPENAI_API_KEY", "VOYAGE_API_KEY", "COHERE_API_KEY"]) {
      expect(schema.find((e) => e.name === key)?.secret).toBe(true);
      expect(schema.find((e) => e.name === key)?.required).toBe(false);
    }
    expect(schema.find((e) => e.name === "HARNESS_EMBEDDING_PROVIDER")?.secret).toBe(false);
  });
});

describe("cap-memory-pg trigram mode (default)", () => {
  it("contributes 2 local tools (write, search) by default", () => {
    const tools = pack.localTools?.(ctx({}));
    expect(tools).toHaveLength(2);
    const names = (tools ?? []).map((t) => t.definition.name);
    expect(names).toEqual(["write", "search"]);
  });

  it("contributes 2 local tools when index is explicitly trigram", () => {
    const tools = pack.localTools?.(ctx({ index: "trigram" }));
    expect(tools).toHaveLength(2);
  });

  it("returns [] from migrations slot in trigram mode (lazy bootstrap stays)", () => {
    const migrations = pack.migrations?.(ctx({}));
    expect(migrations).toEqual([]);
  });
});

describe("cap-memory-pg pgvector mode", () => {
  it("contributes 3 local tools (ingest, search, delete) when index: pgvector", () => {
    const tools = pack.localTools?.(ctx({ index: "pgvector" }));
    expect(tools).toHaveLength(3);
    const names = (tools ?? []).map((t) => t.definition.name).sort();
    expect(names).toEqual(["delete", "ingest", "search"]);
  });

  it("returns one migration with id including the configured embeddingDim", () => {
    const migrations = pack.migrations?.(ctx({ index: "pgvector" }));
    expect(migrations).toHaveLength(1);
    expect(migrations?.[0]?.id).toBe("0001_pgvector_d1536");
    expect(migrations?.[0]?.sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(migrations?.[0]?.sql).toContain("vector(1536)");
    expect(migrations?.[0]?.sql).toContain("ivfflat");
  });

  it("encodes a non-default embeddingDim into both the migration id and SQL", () => {
    const migrations = pack.migrations?.(ctx({ index: "pgvector", embeddingDim: 1024 }));
    expect(migrations?.[0]?.id).toBe("0001_pgvector_d1024");
    expect(migrations?.[0]?.sql).toContain("vector(1024)");
    expect(migrations?.[0]?.sql).not.toContain("vector(1536)");
  });

  it("ingest tool returns an actionable error when no provider key is set", async () => {
    const tools = pack.localTools?.(ctx({ index: "pgvector" }, {})) ?? [];
    const ingest = tools.find((t) => t.definition.name === "ingest");
    expect(ingest).toBeDefined();
    if (!ingest) return;
    const result = await ingest.handler({
      input: { text: "hello world" },
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
    expect(result.content).toMatch(/no embedding provider configured/);
    expect(result.content).toMatch(/OPENAI_API_KEY/);
  });

  it("search tool returns an actionable error when no provider key is set", async () => {
    const tools = pack.localTools?.(ctx({ index: "pgvector" }, {})) ?? [];
    const search = tools.find((t) => t.definition.name === "search");
    expect(search).toBeDefined();
    if (!search) return;
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
    expect(result.content).toMatch(/no embedding provider configured/);
  });

  it("delete tool requires at least one of {id, source_id, all}", async () => {
    const tools = pack.localTools?.(ctx({ index: "pgvector" }, {})) ?? [];
    const del = tools.find((t) => t.definition.name === "delete");
    if (!del) throw new Error("delete tool missing");
    const result = await del.handler({
      input: {},
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
    expect(result.content).toMatch(/id, source_id, all/);
  });
});

describe("cap-memory-pg skills", () => {
  it("contributes two skills with reachable contentPath files", () => {
    const skills = pack.skills?.(ctx({})) ?? [];
    const names = skills.map((s) => s.name);
    expect(names).toEqual(["memory", "rag-ingestion"]);
    for (const skill of skills) {
      expect(existsSync(skill.contentPath)).toBe(true);
    }
  });
});

describe("defaultEmbeddingProviderKeyEnv", () => {
  it("maps provider id to env var name", () => {
    expect(defaultEmbeddingProviderKeyEnv("openai")).toBe("OPENAI_API_KEY");
    expect(defaultEmbeddingProviderKeyEnv("voyage")).toBe("VOYAGE_API_KEY");
    expect(defaultEmbeddingProviderKeyEnv("cohere")).toBe("COHERE_API_KEY");
  });
});
