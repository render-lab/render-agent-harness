import { describe, expect, it } from "vitest";
import { HarnessConfigSchema, IndexSchema, parseHarnessConfigYaml } from "./schema.js";

describe("HarnessConfigSchema", () => {
  it("accepts a minimal builtin entry", () => {
    const cfg = HarnessConfigSchema.parse({
      schemaVersion: 1,
      name: "demo",
      description: "A minimal demo entry.",
      harnessVersion: "^0.1",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "Hello." },
      runtimes: [{ kind: "web" }],
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    expect(cfg.name).toBe("demo");
    expect(cfg.runtimes[0]?.kind).toBe("web");
  });

  it("rejects duplicate runtime kinds", () => {
    expect(() =>
      HarnessConfigSchema.parse({
        schemaVersion: 1,
        name: "demo",
        description: "x",
        harnessVersion: "^0.1",
        agent: { kind: "builtin", ref: "chat", systemPrompt: "x" },
        runtimes: [{ kind: "web" }, { kind: "web" }],
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    ).toThrow(/duplicate runtime kind/);
  });

  it("requires a SHOUT_CASE env var name", () => {
    expect(() =>
      HarnessConfigSchema.parse({
        schemaVersion: 1,
        name: "demo",
        description: "x",
        harnessVersion: "^0.1",
        agent: { kind: "builtin", ref: "chat", systemPrompt: "x" },
        runtimes: [{ kind: "web" }],
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        envSchema: [{ name: "lowercase_var", required: true, secret: false }],
      }),
    ).toThrow();
  });

  it("parses YAML round-trip", () => {
    const yaml = `
schemaVersion: 1
name: demo
description: A demo entry.
harnessVersion: "^0.1"
agent:
  kind: builtin
  ref: chat
  systemPrompt: Hello.
runtimes:
  - kind: cron
    schedule: "0 13 * * *"
model:
  provider: anthropic
  model: claude-sonnet-4-6
`;
    const cfg = parseHarnessConfigYaml(yaml);
    expect(cfg.runtimes[0]).toMatchObject({ kind: "cron", schedule: "0 13 * * *" });
  });
});

describe("IndexSchema", () => {
  it("rejects non-SHA refs", () => {
    expect(() =>
      IndexSchema.parse({
        schemaVersion: 1,
        entries: [
          {
            name: "demo",
            description: "x",
            repo: "https://github.com/foo/bar",
            ref: "v0.1.0",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate entry names", () => {
    expect(() =>
      IndexSchema.parse({
        schemaVersion: 1,
        entries: [
          {
            name: "demo",
            description: "x",
            repo: "https://github.com/foo/bar",
            ref: "0".repeat(40),
          },
          {
            name: "demo",
            description: "y",
            repo: "https://github.com/foo/baz",
            ref: "1".repeat(40),
          },
        ],
      }),
    ).toThrow(/duplicate entry name/);
  });

  it("accepts a valid entry", () => {
    const idx = IndexSchema.parse({
      schemaVersion: 1,
      entries: [
        {
          name: "demo",
          description: "x",
          repo: "https://github.com/foo/bar",
          ref: "9b2a7c1c3f4e8d6b1a2f3c4d5e6f7a8b9c0d1e2f",
        },
      ],
    });
    expect(idx.entries).toHaveLength(1);
  });
});
