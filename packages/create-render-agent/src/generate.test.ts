import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@render-harness/registry/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildFileMap, generate } from "./generate.js";
import type { Answers, RuntimeSelection } from "./types.js";

const BASE: Omit<Answers, "directory" | "runtimes"> = {
  agentName: "my-agent",
  description: "A test agent.",
  systemPrompt: "You are a helpful assistant.",
  model: "claude-sonnet-4-6",
  capabilities: [],
  templateManifest: null,
  ui: false,
  packageManager: "npm",
  harnessRoot: null,
  gitInit: false,
  installDeps: false,
};

const COMBOS: Array<{ label: string; runtimes: RuntimeSelection[] }> = [
  { label: "web", runtimes: [{ kind: "web" }] },
  { label: "cron", runtimes: [{ kind: "cron", schedule: "0 13 * * *" }] },
  { label: "worker", runtimes: [{ kind: "worker", queue: "my-agent-runs" }] },
  {
    label: "web+worker",
    runtimes: [{ kind: "web" }, { kind: "worker", queue: "my-agent-runs" }],
  },
  {
    label: "web+cron",
    runtimes: [{ kind: "web" }, { kind: "cron", schedule: "0 13 * * *" }],
  },
  {
    label: "web+worker+cron",
    runtimes: [
      { kind: "web" },
      { kind: "worker", queue: "my-agent-runs" },
      { kind: "cron", schedule: "0 13 * * *" },
    ],
  },
];

describe("buildFileMap", () => {
  for (const { label, runtimes } of COMBOS) {
    it(`emits a complete file map for ${label}`, () => {
      const answers: Answers = { ...BASE, directory: `/tmp/${label}`, runtimes };
      const map = buildFileMap(answers);
      const snapshot = Object.fromEntries(
        [...map.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
      expect(snapshot).toMatchSnapshot();
    });

    it(`generates yaml that passes HarnessConfigSchema for ${label}`, () => {
      const answers: Answers = { ...BASE, directory: `/tmp/${label}`, runtimes };
      const map = buildFileMap(answers);
      const yamlText = map.get("render-harness.yaml");
      expect(yamlText).toBeTruthy();
      const parsed = parseYaml(yamlText ?? "");
      expect(() => HarnessConfigSchema.parse(parsed)).not.toThrow();
    });
  }

  it("includes capability dependencies in package.json", () => {
    const answers: Answers = {
      ...BASE,
      directory: "/tmp/caps",
      runtimes: [{ kind: "web" }],
      capabilities: [{ pack: "@render-harness/cap-search-exa" }],
    };
    const map = buildFileMap(answers);
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@render-harness/cap-search-exa"]).toBeDefined();
  });

  it("swaps to @render-harness/web + ui deps when ui is enabled", () => {
    const map = buildFileMap({
      ...BASE,
      directory: "/tmp/ui",
      ui: true,
      runtimes: [{ kind: "web" }, { kind: "worker", queue: "my-agent-runs" }],
    });
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@render-harness/web"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/ui"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/runtime-web"]).toBeUndefined();
    expect(pkg.dependencies["@render-harness/runtime-worker"]).toBeDefined();

    const webEntry = map.get("src/web.ts") ?? "";
    expect(webEntry).toContain("serveWeb");
    expect(webEntry).toContain("ui: true");

    const env = map.get(".env.example") ?? "";
    expect(env).toContain("WEB_API_KEY");
    expect(env).toContain("UI_COOKIE_SECRET");
  });

  it("keeps the simple runtime-web shape when ui is disabled", () => {
    const map = buildFileMap({
      ...BASE,
      directory: "/tmp/no-ui",
      ui: false,
      runtimes: [{ kind: "web" }],
    });
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@render-harness/runtime-web"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/web"]).toBeUndefined();
    expect(pkg.dependencies["@render-harness/ui"]).toBeUndefined();
    expect(map.get("src/main.ts")).toContain("serveAgent");
  });

  it("emits a docker-compose.yml with namespaced container names", () => {
    const map = buildFileMap({
      ...BASE,
      directory: "/tmp/compose",
      agentName: "alice-bot",
      runtimes: [{ kind: "web" }],
    });
    const compose = map.get("docker-compose.yml") ?? "";
    expect(compose).toContain("name: alice-bot");
    expect(compose).toContain("container_name: alice-bot-postgres");
    expect(compose).toContain("container_name: alice-bot-valkey");
    expect(compose).toContain("postgres:17-alpine");
    expect(compose).toContain("valkey/valkey:8-alpine");
  });

  it("includes db:* and combined dev scripts", () => {
    const single = JSON.parse(
      buildFileMap({ ...BASE, directory: "/tmp/x", runtimes: [{ kind: "web" }] }).get(
        "package.json",
      ) ?? "{}",
    ) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(single.scripts["db:up"]).toContain("docker compose up");
    expect(single.scripts["db:reset"]).toContain("down -v");
    expect(single.devDependencies.concurrently).toBeUndefined();

    const multi = JSON.parse(
      buildFileMap({
        ...BASE,
        directory: "/tmp/y",
        runtimes: [{ kind: "web" }, { kind: "worker", queue: "q" }],
      }).get("package.json") ?? "{}",
    ) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(multi.scripts.dev).toContain("concurrently");
    expect(multi.scripts.dev).toContain("npm:dev:web");
    expect(multi.scripts.dev).toContain("npm:dev:worker");
    expect(multi.devDependencies.concurrently).toBeDefined();
  });

  it("uses the chosen package manager in the README", () => {
    const npmReadme =
      buildFileMap({
        ...BASE,
        directory: "/tmp/npm",
        packageManager: "npm",
        runtimes: [{ kind: "web" }],
      }).get("README.md") ?? "";
    expect(npmReadme).toContain("npm install");
    expect(npmReadme).toContain("npm run db:up");
    expect(npmReadme).not.toContain("pnpm db:up");

    const pnpmReadme =
      buildFileMap({
        ...BASE,
        directory: "/tmp/pnpm",
        packageManager: "pnpm",
        runtimes: [{ kind: "web" }],
      }).get("README.md") ?? "";
    expect(pnpmReadme).toContain("pnpm install");
    expect(pnpmReadme).toContain("pnpm run db:up");

    const yarnReadme =
      buildFileMap({
        ...BASE,
        directory: "/tmp/yarn",
        packageManager: "yarn",
        runtimes: [{ kind: "web" }],
      }).get("README.md") ?? "";
    expect(yarnReadme).toContain("yarn install");
    expect(yarnReadme).toContain("yarn db:up");
    expect(yarnReadme).not.toContain("yarn run");
  });

  it("uses the universal `npm:` prefix in the concurrently script", () => {
    const pkg = JSON.parse(
      buildFileMap({
        ...BASE,
        directory: "/tmp/conc",
        packageManager: "pnpm",
        runtimes: [{ kind: "web" }, { kind: "worker", queue: "q" }],
      }).get("package.json") ?? "{}",
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toContain("npm:dev:web");
    expect(pkg.scripts.dev).not.toContain("pnpm:");
  });

  it("points .env.example at the local compose stack by default", () => {
    const env =
      buildFileMap({
        ...BASE,
        directory: "/tmp/env",
        runtimes: [{ kind: "web" }],
      }).get(".env.example") ?? "";
    expect(env).toContain("DATABASE_URL=postgres://harness:harness@127.0.0.1:55432/harness");
    expect(env).toContain("KV_URL=redis://127.0.0.1:56379");
  });

  it("emits link: deps when harnessRoot is set (local-link mode)", () => {
    const map = buildFileMap({
      ...BASE,
      directory: "/tmp/link",
      harnessRoot: "/Users/me/render-harness",
      runtimes: [{ kind: "web" }],
      capabilities: [{ pack: "@render-harness/cap-search-exa" }],
      ui: true,
    });
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@render-harness/core"]).toBe(
      "link:/Users/me/render-harness/packages/core",
    );
    expect(pkg.dependencies["@render-harness/registry"]).toBe(
      "link:/Users/me/render-harness/packages/registry",
    );
    expect(pkg.dependencies["@render-harness/web"]).toBe(
      "link:/Users/me/render-harness/packages/web",
    );
    expect(pkg.dependencies["@render-harness/ui"]).toBe(
      "link:/Users/me/render-harness/packages/ui",
    );
    // Capabilities live under packages/capabilities/<name>.
    expect(pkg.dependencies["@render-harness/cap-search-exa"]).toBe(
      "link:/Users/me/render-harness/packages/capabilities/cap-search-exa",
    );
    // README explains local-link mode.
    expect(map.get("README.md")).toContain("Local-link mode");
    expect(map.get("README.md")).toContain("/Users/me/render-harness");
  });

  it("defaults to version-range deps when harnessRoot is null", () => {
    const map = buildFileMap({
      ...BASE,
      directory: "/tmp/published",
      runtimes: [{ kind: "web" }],
    });
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@render-harness/core"]).toBe("^0.1");
    expect(pkg.dependencies["@render-harness/registry"]).toBe("^0.1");
    expect(map.get("README.md")).toContain("aren't published yet");
  });

  it("preserves template-declared fields the wizard doesn't collect", () => {
    const templateManifest = {
      schemaVersion: 1,
      name: "research-cron",
      description: "from template",
      harnessVersion: "^0.1",
      license: "MIT",
      agent: { kind: "builtin", ref: "chat", systemPrompt: "from template" },
      runtimes: [{ kind: "cron", plan: "starter", schedule: "0 13 * * *" }],
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      capabilities: [{ pack: "@render-harness/cap-search-exa", config: { defaultMaxResults: 10 } }],
      mcpServers: [{ name: "render", transport: "http", url: "https://mcp.render.com/mcp" }],
      envSchema: [{ name: "RESEARCH_TOPIC", required: true, secret: false }],
    };
    const map = buildFileMap({
      ...BASE,
      directory: "/tmp/template",
      agentName: "my-research",
      description: "user-overridden",
      runtimes: [{ kind: "cron", schedule: "0 9 * * *" }],
      capabilities: [{ pack: "@render-harness/cap-search-exa" }],
      templateManifest,
    });
    const yamlText = map.get("render-harness.yaml") ?? "";
    expect(yamlText).toContain("name: my-research"); // overridden
    expect(yamlText).toContain("description: user-overridden"); // overridden
    expect(yamlText).toContain("schedule: 0 9 * * *"); // overridden
    expect(yamlText).toContain("defaultMaxResults: 10"); // preserved capability config
    expect(yamlText).toContain("mcpServers"); // preserved
    expect(yamlText).toContain("RESEARCH_TOPIC"); // preserved
  });

  it("emits dev:<kind> scripts only for multi-runtime layouts", () => {
    const single = JSON.parse(
      buildFileMap({ ...BASE, directory: "/tmp/x", runtimes: [{ kind: "web" }] }).get(
        "package.json",
      ) ?? "{}",
    ) as { scripts: Record<string, string> };
    expect(single.scripts.dev).toBeDefined();
    expect(single.scripts["dev:web"]).toBeUndefined();

    const multi = JSON.parse(
      buildFileMap({
        ...BASE,
        directory: "/tmp/x",
        runtimes: [{ kind: "web" }, { kind: "worker", queue: "q" }],
      }).get("package.json") ?? "{}",
    ) as { scripts: Record<string, string> };
    // Multi-runtime layouts ship a combined `dev` (concurrently) alongside
    // per-runtime `dev:<kind>` scripts.
    expect(multi.scripts.dev).toContain("concurrently");
    expect(multi.scripts["dev:web"]).toBeDefined();
    expect(multi.scripts["dev:worker"]).toBeDefined();
  });
});

describe("generate", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "create-render-agent-"));
  });

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("writes all expected files to disk", async () => {
    const directory = join(tempRoot, "my-agent");
    const result = await generate({
      ...BASE,
      directory,
      runtimes: [{ kind: "web" }],
    });

    expect(result.targetDir).toBe(directory);
    const onDisk = (await readdir(directory)).sort();
    expect(onDisk).toEqual(
      [
        ".env.example",
        ".gitignore",
        "README.md",
        "agent",
        "docker-compose.yml",
        "package.json",
        "render-harness.yaml",
        "src",
        "tsconfig.json",
        "tsup.config.ts",
      ].sort(),
    );
    expect((await stat(join(directory, "agent", "index.ts"))).isFile()).toBe(true);
    expect((await stat(join(directory, "src", "main.ts"))).isFile()).toBe(true);
  });

  it("emits per-runtime entries for multi-runtime layouts", async () => {
    const directory = join(tempRoot, "multi");
    await generate({
      ...BASE,
      directory,
      runtimes: [{ kind: "web" }, { kind: "worker", queue: "multi-runs" }],
    });

    expect((await stat(join(directory, "src", "web.ts"))).isFile()).toBe(true);
    expect((await stat(join(directory, "src", "worker.ts"))).isFile()).toBe(true);
    const yaml = await readFile(join(directory, "render-harness.yaml"), "utf8");
    expect(yaml).toContain("kind: web");
    expect(yaml).toContain("kind: worker");
    expect(yaml).toContain("queue: multi-runs");
  });

  it("refuses to write into a non-empty directory", async () => {
    const directory = join(tempRoot, "occupied");
    await generate({ ...BASE, directory, runtimes: [{ kind: "web" }] });
    await expect(generate({ ...BASE, directory, runtimes: [{ kind: "web" }] })).rejects.toThrow(
      /not empty/,
    );
  });

  it("rejects an invalid runtime combo by throwing from validate", () => {
    // Two webs is rejected by the schema's superRefine; the generator
    // validates *before* writing so this should throw without touching
    // disk.
    expect(() =>
      buildFileMap({
        ...BASE,
        directory: "/tmp/dup",
        runtimes: [{ kind: "web" }, { kind: "web" }],
      }),
    ).toThrow();
  });
});
