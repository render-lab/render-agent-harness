import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@render-harness/registry/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildFileMap, generate } from "./generate.js";
import type { Answers, RuntimeSelection } from "./types.js";
import { DEFAULT_HARNESS_VERSION_RANGE } from "./version-ranges.js";

const BASE: Omit<Answers, "directory" | "runtimes"> = {
  agentName: "my-agent",
  description: "A test agent.",
  systemPrompt: "You are a helpful assistant.",
  model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  capabilities: [],
  templateManifest: null,
  bundle: null,
  ui: false,
  packageManager: "npm",
  harnessRoot: null,
  gitInit: false,
  installDeps: false,
};

const CHIEF_OF_STAFF_MANIFEST = {
  schemaVersion: 1,
  name: "chief-of-staff",
  description: "Personal chief of staff bundle.",
  harnessVersion: "^0.1",
  shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" }, ui: true },
  capabilities: [{ pack: "@render-harness/cap-memory-pg" }],
  envSchema: [{ name: "CALENDAR_ICS_URL", required: false, secret: true }],
  agents: [
    {
      id: "chat",
      agent: { kind: "custom", entrypoint: "./src/chat.ts" },
      runtimes: [{ kind: "web" }, { kind: "worker" }],
    },
    {
      id: "meeting-prep",
      agent: { kind: "custom", entrypoint: "./src/meeting-prep.ts" },
      runtimes: [{ kind: "cron", schedule: "*/15 * * * *" }],
    },
    {
      id: "weekly-recap",
      agent: { kind: "custom", entrypoint: "./src/weekly-recap.ts" },
      runtimes: [{ kind: "cron", schedule: "0 17 * * 5" }],
    },
  ],
};

const CHIEF_OF_STAFF_SOURCES: Record<string, string> = {
  "src/chat.ts": '// chat agent\nexport default { name: "chat" };\n',
  "src/meeting-prep.ts": '// meeting-prep cron agent\nexport default { name: "meeting-prep" };\n',
  "src/weekly-recap.ts": '// weekly-recap cron agent\nexport default { name: "weekly-recap" };\n',
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
    expect(webEntry).toContain('ui: { path: "/" }');

    const env = map.get(".env.example") ?? "";
    expect(env).toContain("WEB_API_KEY");
    expect(env).toContain("UI_COOKIE_SECRET");
  });

  it("emits a complete openai-compat model block when a non-Anthropic preset is picked", () => {
    const map = buildFileMap({
      ...BASE,
      directory: "/tmp/openrouter",
      model: {
        provider: "openai-compat",
        model: "openai/gpt-4o",
        baseURL: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
      runtimes: [{ kind: "web" }],
    });
    const yaml = map.get("render-harness.yaml") ?? "";
    expect(yaml).toContain("provider: openai-compat");
    expect(yaml).toContain("model: openai/gpt-4o");
    expect(yaml).toContain("baseURL: https://openrouter.ai/api/v1");
    expect(yaml).toContain("apiKeyEnv: OPENROUTER_API_KEY");
    // Parses cleanly under the registry schema.
    const parsed = HarnessConfigSchema.parse(parseYaml(yaml));
    expect(parsed.shared?.model).toEqual({
      provider: "openai-compat",
      model: "openai/gpt-4o",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    });
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
    // Range is derived from the current workspace registry version at
    // build time (see version-ranges.ts) — assert against the same source
    // of truth so the test never drifts from what the scaffolder emits.
    expect(pkg.dependencies["@render-harness/core"]).toBe(DEFAULT_HARNESS_VERSION_RANGE);
    expect(pkg.dependencies["@render-harness/registry"]).toBe(DEFAULT_HARNESS_VERSION_RANGE);
    expect(map.get("README.md")).toContain("published npm packages");
  });

  it("preserves template-declared fields the wizard doesn't collect", () => {
    const templateManifest = {
      schemaVersion: 1,
      name: "research-cron",
      description: "from template",
      harnessVersion: "^0.1",
      license: "MIT",
      shared: {
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      capabilities: [{ pack: "@render-harness/cap-search-exa", config: { defaultMaxResults: 10 } }],
      envSchema: [{ name: "RESEARCH_TOPIC", required: true, secret: false }],
      agents: [
        {
          id: "research-cron",
          agent: { kind: "builtin", ref: "chat", systemPrompt: "from template" },
          runtimes: [{ kind: "cron", plan: "starter", schedule: "0 13 * * *" }],
          mcpServers: [{ name: "render", transport: "http", url: "https://mcp.render.com/mcp" }],
        },
      ],
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
    expect(yamlText).toContain("mcpServers"); // preserved (lands on the one agent)
    expect(yamlText).toContain("RESEARCH_TOPIC"); // preserved (top-level envSchema)
  });

  it("rewrites capability config.agent to the scaffolded agent id", () => {
    // Template pins the connector to its own agent id (`support-bot`).
    // The wizard creates one agent named `slack-smoke` — the scaffolded
    // capability config must point at that agent, not the template's.
    const templateManifest = {
      schemaVersion: 1,
      name: "support-bot",
      description: "from template",
      harnessVersion: "^0.2",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      capabilities: [
        {
          pack: "@render-harness/cap-slack",
          config: {
            agent: "support-bot",
            accessMode: "read_write",
            signingSecretEnv: "SLACK_SIGNING_SECRET",
            botTokenEnv: "SLACK_BOT_TOKEN",
          },
        },
      ],
      agents: [
        {
          id: "support-bot",
          agent: { kind: "builtin", ref: "chat", systemPrompt: "p" },
          runtimes: [{ kind: "web", plan: "starter" }],
        },
      ],
    };
    const yamlText =
      buildFileMap({
        ...BASE,
        directory: "/tmp/retarget",
        agentName: "slack-smoke",
        runtimes: [{ kind: "web" }, { kind: "worker", queue: "slack-smoke-runs" }],
        capabilities: [{ pack: "@render-harness/cap-slack" }],
        templateManifest,
      }).get("render-harness.yaml") ?? "";
    expect(yamlText).toContain("agent: slack-smoke");
    expect(yamlText).not.toContain("agent: support-bot");
    // Other template config fields are preserved unchanged.
    expect(yamlText).toContain("accessMode: read_write");
    expect(yamlText).toContain("signingSecretEnv: SLACK_SIGNING_SECRET");
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

  it("uses serveWeb and connector env docs when connector capabilities are selected", () => {
    const map = buildFileMap({
      ...BASE,
      directory: "/tmp/connectors",
      runtimes: [{ kind: "web" }, { kind: "worker", queue: "work-runs" }],
      capabilities: [
        { pack: "@render-harness/cap-github" },
        { pack: "@render-harness/cap-linear" },
      ],
    });
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@render-harness/web"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/runtime-web"]).toBeUndefined();
    expect(map.get("src/web.ts")).toContain('connectors: "from-config"');
    expect(map.get(".env.example")).toContain("GITHUB_WEBHOOK_SECRET=");
    expect(map.get(".env.example")).toContain("LINEAR_WEBHOOK_SECRET=");
    expect(map.get("README.md")).toContain("/connectors/github");
    expect(map.get("README.md")).toContain("/connectors/linear");
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
        ".env",
        ".env.example",
        ".gitignore",
        ".render-harness",
        "README.md",
        "agent",
        "docker-compose.yml",
        "package.json",
        "render-harness.yaml",
        "render.yaml",
        "src",
        "tsconfig.json",
        "tsup.config.ts",
      ].sort(),
    );
    expect((await stat(join(directory, "agent", "index.ts"))).isFile()).toBe(true);
    expect((await stat(join(directory, "src", "main.ts"))).isFile()).toBe(true);
    expect((await stat(join(directory, ".render-harness", "agent.json"))).isFile()).toBe(true);
    const blueprint = await readFile(join(directory, "render.yaml"), "utf8");
    expect(blueprint).toContain("services:");
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

describe("buildFileMap — sealed bundle", () => {
  function bundleAnswers(): Answers {
    return {
      ...BASE,
      directory: "/tmp/cos",
      agentName: "chief-of-staff",
      description: "Personal chief of staff.",
      runtimes: [],
      bundle: {
        slug: "chief-of-staff",
        manifest: CHIEF_OF_STAFF_MANIFEST as unknown as Record<string, unknown>,
        sourceFiles: CHIEF_OF_STAFF_SOURCES,
        runtimeKinds: ["web", "worker", "cron"] as const,
        capabilities: ["@render-harness/cap-memory-pg"] as const,
      },
    };
  }

  it("materializes the manifest + verbatim source tree + generated runtime entries", () => {
    const map = buildFileMap(bundleAnswers());
    const keys = [...map.keys()].sort();
    // Verbatim bundle sources
    expect(keys).toContain("src/chat.ts");
    expect(keys).toContain("src/meeting-prep.ts");
    expect(keys).toContain("src/weekly-recap.ts");
    expect(map.get("src/chat.ts")).toBe(CHIEF_OF_STAFF_SOURCES["src/chat.ts"]);
    // Generated runtime entries (one per runtime kind across all agents)
    expect(keys).toContain("src/web.ts");
    expect(keys).toContain("src/worker.ts");
    expect(keys).toContain("src/cron.ts");
    expect(map.get("src/web.ts")).toContain("serveWeb");
    expect(map.get("src/worker.ts")).toContain("startWorkerAndWait");
    expect(map.get("src/cron.ts")).toContain("runCronFromRegistryAndExit");
    expect(map.get("src/cron.ts")).toContain("HARNESS_AGENT_ID");
    // Generated project scaffolding
    expect(keys).toContain("package.json");
    expect(keys).toContain("tsup.config.ts");
    expect(keys).toContain("tsconfig.json");
    expect(keys).toContain("render-harness.yaml");
    expect(keys).toContain("README.md");
    expect(keys).toContain(".env.example");
    expect(keys).toContain(".gitignore");
    expect(keys).toContain("docker-compose.yml");
    // NO single-agent agent/index.ts in bundle mode
    expect(keys).not.toContain("agent/index.ts");
  });

  it("emits a V2 manifest verbatim", () => {
    const map = buildFileMap(bundleAnswers());
    const yamlText = map.get("render-harness.yaml") ?? "";
    expect(yamlText).toContain("schemaVersion: 1");
    expect(yamlText).toContain("name: chief-of-staff");
    expect(yamlText).toContain("id: chat");
    expect(yamlText).toContain("id: meeting-prep");
    expect(yamlText).toContain("id: weekly-recap");
  });

  it("wires bundle deps in package.json (web/worker/cron + registry + cap)", () => {
    const map = buildFileMap(bundleAnswers());
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@render-harness/web"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/runtime-worker"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/runtime-cron"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/registry"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/cap-memory-pg"]).toBeDefined();
    // Bundles never ship runtime-web (single-process) — always multi-tenant.
    expect(pkg.dependencies["@render-harness/runtime-web"]).toBeUndefined();
  });

  it("tsup config lists exactly the runtime kinds present", () => {
    const map = buildFileMap(bundleAnswers());
    const tsup = map.get("tsup.config.ts") ?? "";
    expect(tsup).toMatch(/"web":\s*"src\/web\.ts"/);
    expect(tsup).toMatch(/"worker":\s*"src\/worker\.ts"/);
    expect(tsup).toMatch(/"cron":\s*"src\/cron\.ts"/);
  });

  it("README points users at HARNESS_AGENT_ID for cron agents", () => {
    const md = buildFileMap(bundleAnswers()).get("README.md") ?? "";
    expect(md).toContain("HARNESS_AGENT_ID=");
    expect(md).toContain("chief-of-staff");
  });

  it("generated runtime entries win on collision with bundle sourceFiles", () => {
    const conflicting = bundleAnswers();
    const bundle = conflicting.bundle;
    if (!bundle) throw new Error("expected bundle answers");
    // Inject a `src/web.ts` into the bundle's source map; the generator
    // should still emit its own (which knows about V2 multi-agent).
    conflicting.bundle = {
      ...bundle,
      sourceFiles: {
        ...bundle.sourceFiles,
        "src/web.ts": "// SHOULD BE OVERWRITTEN\n",
      },
    };
    const map = buildFileMap(conflicting);
    expect(map.get("src/web.ts")).toContain("serveWeb");
    expect(map.get("src/web.ts")).not.toContain("SHOULD BE OVERWRITTEN");
  });
});

describe("buildFileMap — bundle with workflow-mode agents", () => {
  const HYBRID_MANIFEST = {
    schemaVersion: 1,
    name: "hybrid-bundle",
    description: "Inline cron + via:workflow cron + workflows-only.",
    harnessVersion: "^0.1",
    shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" }, ui: true },
    agents: [
      {
        id: "chat",
        agent: { kind: "custom", entrypoint: "./src/chat.ts" },
        runtimes: [{ kind: "web" }, { kind: "worker" }],
      },
      {
        id: "fast-check",
        agent: { kind: "custom", entrypoint: "./src/fast-check.ts" },
        runtimes: [{ kind: "cron", schedule: "*/15 * * * *" }],
      },
      {
        id: "weekly-recap",
        agent: { kind: "custom", entrypoint: "./src/weekly-recap.ts" },
        workflowTask: true,
        runtimes: [{ kind: "cron", schedule: "0 17 * * 5", via: "workflow" }],
      },
      {
        id: "deep-research",
        agent: { kind: "custom", entrypoint: "./src/deep-research.ts" },
        workflowTask: true,
        runtimes: [{ kind: "workflows" }],
      },
    ],
  };

  const HYBRID_SOURCES: Record<string, string> = {
    "src/chat.ts": "// chat\n",
    "src/fast-check.ts": "// fast-check\n",
    "src/weekly-recap.ts": "// weekly-recap\n",
    "src/deep-research.ts": "// deep-research\n",
  };

  function hybridAnswers(): Answers {
    return {
      ...BASE,
      directory: "/tmp/hybrid",
      agentName: "hybrid-bundle",
      description: "Hybrid bundle.",
      runtimes: [],
      bundle: {
        slug: "hybrid-bundle",
        manifest: HYBRID_MANIFEST as unknown as Record<string, unknown>,
        sourceFiles: HYBRID_SOURCES,
        runtimeKinds: ["web", "worker", "cron", "workflows"] as const,
        capabilities: [] as const,
      },
    };
  }

  it("emits cron-trigger and workflows entries when needed", () => {
    const map = buildFileMap(hybridAnswers());
    const keys = [...map.keys()].sort();
    // Inline cron (fast-check) → src/cron.ts present
    expect(keys).toContain("src/cron.ts");
    // via:workflow cron (weekly-recap) → src/cron-trigger.ts present
    expect(keys).toContain("src/cron-trigger.ts");
    expect(map.get("src/cron-trigger.ts")).toContain("triggerAgentWorkflow");
    expect(map.get("src/cron-trigger.ts")).toContain("WORKFLOW_TASK_REF");
    // Workflow tasks (weekly-recap + deep-research) → src/workflows.ts present
    expect(keys).toContain("src/workflows.ts");
    expect(map.get("src/workflows.ts")).toContain("isWorkflowTaskAgent");
    expect(map.get("src/workflows.ts")).toContain('from "@renderinc/sdk/workflows"');
  });

  it("wires renderinc/sdk + runtime-workflows deps when workflow tasks exist", () => {
    const map = buildFileMap(hybridAnswers());
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@renderinc/sdk"]).toBeDefined();
    expect(pkg.dependencies["@render-harness/runtime-workflows"]).toBeDefined();
    // Inline cron still pulls runtime-cron.
    expect(pkg.dependencies["@render-harness/runtime-cron"]).toBeDefined();
  });

  it("omits src/cron.ts when only via:workflow crons are present", () => {
    const answers = hybridAnswers();
    const bundle = answers.bundle;
    if (!bundle) throw new Error("expected bundle answers");
    // Mutate manifest to remove inline cron — only via:workflow + workflows.
    const trimmedManifest = {
      ...HYBRID_MANIFEST,
      agents: HYBRID_MANIFEST.agents.filter((a) => a.id !== "fast-check"),
    };
    answers.bundle = {
      ...bundle,
      manifest: trimmedManifest as unknown as Record<string, unknown>,
    };
    const map = buildFileMap(answers);
    expect(map.has("src/cron.ts")).toBe(false);
    expect(map.has("src/cron-trigger.ts")).toBe(true);
    expect(map.has("src/workflows.ts")).toBe(true);
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    // No inline cron → no runtime-cron dep.
    expect(pkg.dependencies["@render-harness/runtime-cron"]).toBeUndefined();
  });

  it("tsup config includes cron-trigger and workflows entries when present", () => {
    const tsup = buildFileMap(hybridAnswers()).get("tsup.config.ts") ?? "";
    expect(tsup).toMatch(/"cron-trigger":\s*"src\/cron-trigger\.ts"/);
    expect(tsup).toMatch(/"workflows":\s*"src\/workflows\.ts"/);
  });

  it("emits a combined `dev` script via concurrently for long-running services", () => {
    const map = buildFileMap(hybridAnswers());
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts.dev).toContain("concurrently");
    expect(pkg.scripts.dev).toContain("npm:dev:web");
    expect(pkg.scripts.dev).toContain("npm:dev:worker");
    expect(pkg.scripts.dev).toContain("npm:dev:workflows");
    expect(pkg.scripts["dev:workflows"]).toContain("render workflows dev");
    expect(pkg.devDependencies.concurrently).toBeDefined();
  });

  it("emits db:up / db:down / db:reset wrapping docker compose", () => {
    const map = buildFileMap(hybridAnswers());
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["db:up"]).toContain("docker compose up");
    expect(pkg.scripts["db:down"]).toContain("docker compose down");
    expect(pkg.scripts["db:reset"]).toContain("docker compose down -v");
  });

  it("emits .env alongside .env.example with bundle defaults pre-filled", () => {
    const map = buildFileMap(hybridAnswers());
    const env = map.get(".env") ?? "";
    const envExample = map.get(".env.example") ?? "";
    // Both files exist + are identical at scaffold time (one is for git,
    // the other is the working copy).
    expect(env).toBeTruthy();
    expect(envExample).toBeTruthy();
    expect(env).toBe(envExample);

    // Bundle-derived constants are pre-filled — no manual work needed.
    expect(env).toContain("DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres");
    expect(env).toContain("KV_URL=redis://127.0.0.1:56379");
    expect(env).toContain("WORKFLOW_SLUG=hybrid-bundle-workflows");
    expect(env).toContain("RENDER_USE_LOCAL_DEV=true");

    // Real secrets are present as empty slots with "fill in" hints.
    expect(env).toMatch(/^ANTHROPIC_API_KEY=$/m);
    expect(env).toMatch(/^RENDER_API_KEY=$/m);
    expect(env).toContain("# fill in");
  });

  it("emits WEB_API_KEY + UI_COOKIE_SECRET when shared.ui is true", () => {
    const env = buildFileMap(hybridAnswers()).get(".env") ?? "";
    // hybridAnswers uses HYBRID_MANIFEST which has shared.ui: true.
    expect(env).toContain("WEB_API_KEY=demo");
    expect(env).toContain("UI_COOKIE_SECRET=");
    // The default is a clearly-not-secret placeholder for local dev.
    expect(env).toContain("local-dev-only");
  });

  it("omits UI env vars when shared.ui is unset/false", () => {
    const noUiManifest = {
      schemaVersion: 1,
      name: "no-ui",
      description: "No UI bundle.",
      harnessVersion: "^0.1",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      agents: [
        {
          id: "x",
          agent: { kind: "custom", entrypoint: "./src/x.ts" },
          runtimes: [{ kind: "web" }],
        },
      ],
    };
    const answers: Answers = {
      ...BASE,
      directory: "/tmp/no-ui",
      agentName: "no-ui",
      runtimes: [],
      bundle: {
        slug: "no-ui",
        manifest: noUiManifest as unknown as Record<string, unknown>,
        sourceFiles: { "src/x.ts": "// x\n" },
        runtimeKinds: ["web"] as const,
        capabilities: [] as const,
      },
    };
    const env = buildFileMap(answers).get(".env") ?? "";
    expect(env).not.toContain("WEB_API_KEY");
    expect(env).not.toContain("UI_COOKIE_SECRET");
  });

  it("omits workflow env vars when the bundle has no workflow tasks", () => {
    const minimal = {
      schemaVersion: 1,
      name: "no-wf",
      description: "Plain bundle.",
      harnessVersion: "^0.1",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      agents: [
        {
          id: "no-wf",
          agent: { kind: "custom", entrypoint: "./src/no-wf.ts" },
          runtimes: [{ kind: "web" }, { kind: "worker" }],
        },
      ],
    };
    const answers: Answers = {
      ...BASE,
      directory: "/tmp/no-wf",
      agentName: "no-wf",
      runtimes: [],
      bundle: {
        slug: "no-wf",
        manifest: minimal as unknown as Record<string, unknown>,
        sourceFiles: { "src/no-wf.ts": "// x\n" },
        runtimeKinds: ["web", "worker"] as const,
        capabilities: [] as const,
      },
    };
    const env = buildFileMap(answers).get(".env") ?? "";
    expect(env).not.toContain("WORKFLOW_SLUG");
    expect(env).not.toContain("RENDER_USE_LOCAL_DEV");
    expect(env).not.toContain("RENDER_API_KEY");
    expect(env).toContain("ANTHROPIC_API_KEY=");
  });

  it("omits concurrently when only one long-running service exists", () => {
    // Construct a deliberately-minimal bundle with one web-only agent.
    // No worker, no workflows → only `dev:web` is long-running, so no
    // need to coordinate via concurrently.
    const minimalManifest = {
      schemaVersion: 1,
      name: "tiny",
      description: "Single-service bundle.",
      harnessVersion: "^0.1",
      shared: { model: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      agents: [
        {
          id: "tiny",
          agent: { kind: "custom", entrypoint: "./src/tiny.ts" },
          runtimes: [{ kind: "web" }],
        },
      ],
    };
    const answers: Answers = {
      ...BASE,
      directory: "/tmp/tiny",
      agentName: "tiny",
      runtimes: [],
      bundle: {
        slug: "tiny",
        manifest: minimalManifest as unknown as Record<string, unknown>,
        sourceFiles: { "src/tiny.ts": "// tiny\n" },
        runtimeKinds: ["web"] as const,
        capabilities: [] as const,
      },
    };
    const map = buildFileMap(answers);
    const pkg = JSON.parse(map.get("package.json") ?? "{}") as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies.concurrently).toBeUndefined();
    expect(pkg.scripts.dev).toBeUndefined();
    expect(pkg.scripts["dev:web"]).toBe("tsx src/web.ts");
  });
});
