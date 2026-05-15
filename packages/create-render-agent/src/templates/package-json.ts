import { posix } from "node:path";
import { type Answers, isMultiRuntime, runtimePackageFor } from "../types.js";

/**
 * Builds the scaffolded project's package.json. Layout follows the
 * existing template at templates/render-harness-entry/:
 *
 *   - single runtime → scripts.dev / scripts.start point at src/main.ts
 *   - multi runtime  → scripts.dev:<kind> / scripts.start:<kind> per runtime,
 *                      `main` points at the first entry's dist file
 *
 * Harness deps:
 *   - When `answers.harnessRoot` is null (default), `@render-harness/*` deps
 *     are pinned to `^0.1` — the published version range.
 *   - When `answers.harnessRoot` is set, the deps become `link:` references
 *     pointing into that checkout, so `pnpm install` works against the
 *     local source today.
 */
export function packageJson(answers: Answers): string {
  const multi = isMultiRuntime(answers);
  const runtimeKinds = answers.runtimes.map((r) => r.kind);
  const harnessDep = (pkgName: string): string => harnessDepVersion(pkgName, answers.harnessRoot);

  const scripts: Record<string, string> = {
    build: "render-harness-build && tsup",
    "build:bp": "render-harness-build",
    "build:check": "render-harness-build --check",
    "build:tsup": "tsup",
    typecheck: "tsc --noEmit",
    "db:up": "docker compose up -d --wait",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d --wait",
    "db:logs": "docker compose logs -f",
  };

  if (multi) {
    for (const kind of runtimeKinds) {
      scripts[`dev:${kind}`] = `tsx watch src/${kind}.ts`;
      scripts[`start:${kind}`] = `node dist/${kind}.js`;
    }
    // Combined `dev` runs every runtime under concurrently with
    // colour-coded prefixes and shared signal handling. The `npm:` prefix
    // is universal — concurrently resolves it to `npm run dev:<kind>`,
    // which works under any package manager (npm is bundled with Node).
    const names = runtimeKinds.join(",");
    const targets = runtimeKinds.map((k) => `npm:dev:${k}`).join(" ");
    scripts.dev = `concurrently --kill-others-on-fail --names ${names} ${targets}`;
  } else {
    scripts.dev = "tsx src/main.ts";
    scripts.start = "node dist/main.js";
  }

  const mainEntry = multi ? `./dist/${runtimeKinds[0]}.js` : "./dist/main.js";

  const dependencies: Record<string, string> = {
    "@render-harness/core": harnessDep("@render-harness/core"),
    "@render-harness/registry": harnessDep("@render-harness/registry"),
  };
  for (const kind of runtimeKinds) {
    // With UI enabled the web entry uses @render-harness/web (not runtime-web),
    // which transitively wraps runtime-web. Skip the direct runtime-web dep.
    if (kind === "web" && answers.ui) continue;
    const pkg = runtimePackageFor(kind);
    dependencies[pkg] = harnessDep(pkg);
  }
  if (answers.ui) {
    dependencies["@render-harness/web"] = harnessDep("@render-harness/web");
    dependencies["@render-harness/ui"] = harnessDep("@render-harness/ui");
  }
  // dotenv is used by cron, worker, and the UI-flavored web entry for
  // .env loading during local dev.
  if (runtimeKinds.includes("cron") || runtimeKinds.includes("worker") || answers.ui) {
    dependencies.dotenv = "^17.4.2";
  }
  for (const cap of answers.capabilities) {
    dependencies[cap.pack] = harnessDep(cap.pack);
  }

  const pkg: Record<string, unknown> = {
    name: answers.agentName,
    version: "0.1.0",
    private: true,
    description: answers.description,
    type: "module",
    license: "MIT",
    main: mainEntry,
    files: ["dist", "render-harness.yaml", "render.yaml"],
    scripts,
    dependencies,
    devDependencies: {
      "@types/node": "^25.6.2",
      ...(multi ? { concurrently: "^9.2.1" } : {}),
      tsup: "^8.5.1",
      tsx: "^4.21.0",
      typescript: "^6.0.3",
    },
  };

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Resolve an `@render-harness/*` dependency to either a published
 * version range (default) or a `link:` reference into a local harness
 * checkout.
 *
 * Capability packs live under `packages/capabilities/<name>`; everything
 * else under `packages/<name>`.
 */
function harnessDepVersion(pkgName: string, harnessRoot: string | null): string {
  if (!harnessRoot) return "^0.1";
  const tail = pkgName.replace(/^@render-harness\//, "");
  const subdir = tail.startsWith("cap-") ? `capabilities/${tail}` : tail;
  // Always emit a POSIX-style path. `link:` accepts absolute paths.
  return `link:${posix.join(toPosix(harnessRoot), "packages", subdir)}`;
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}
