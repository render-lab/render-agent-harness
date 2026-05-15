/**
 * Templates for sealed-bundle scaffolds (V2 multi-agent). The bundle's
 * `render-harness.yaml` is emitted verbatim; the bundle's `src/*.ts`
 * (each agent's `defineAgent({...})`) lands verbatim too. The
 * scaffolder generates *additional* runtime entrypoints around them:
 *
 *  - `src/web.ts`           — when any agent has `kind: web`
 *  - `src/worker.ts`        — when any agent has `kind: worker`
 *  - `src/cron.ts`          — when any agent has `kind: cron` with the
 *                             default `via: cron` (dispatches via
 *                             `HARNESS_AGENT_ID`)
 *  - `src/cron-trigger.ts`  — when any agent has `kind: cron, via: workflow`.
 *                             Thin trigger that calls the Render SDK and
 *                             exits in milliseconds.
 *  - `src/workflows.ts`     — when any agent is a workflow task (`kind:
 *                             workflows` OR `workflowTask: true` OR a
 *                             `via: workflow` cron). Registers each
 *                             workflow-mode agent as a `task()` on the
 *                             bundle's single Workflow service.
 *
 * Each runtime entry loads the bundle once via `defineFromConfig` and
 * hands the resulting `agentsById` map to the runtime.
 */

import { stringify as stringifyYaml } from "yaml";
import type { BundlePick, Answers, PackageManager } from "../types.js";

export type BundleRuntimeKind = "web" | "worker" | "cron";

interface ManifestAgentLite {
  id: string;
  workflowTask?: boolean;
  runtimes?: Array<{ kind?: string; via?: string }>;
}

interface ManifestLite {
  agents?: ManifestAgentLite[];
}

function manifestAgents(bundle: BundlePick): ManifestAgentLite[] {
  const agents = (bundle.manifest as ManifestLite).agents;
  return Array.isArray(agents) ? agents : [];
}

/**
 * Mirror of `isWorkflowTaskAgent` in @render-harness/registry, narrowed
 * to the loose manifest shape carried inside `BundlePick`. Kept in sync
 * with the registry helper by convention — the schema is the contract.
 */
function isWorkflowTask(agent: ManifestAgentLite): boolean {
  if (agent.workflowTask === true) return true;
  for (const rt of agent.runtimes ?? []) {
    if (rt.kind === "workflows") return true;
    if (rt.kind === "cron" && rt.via === "workflow") return true;
  }
  return false;
}

export function bundleHasWorkflowTasks(bundle: BundlePick): boolean {
  return manifestAgents(bundle).some(isWorkflowTask);
}

/**
 * Cron-runtime agents split into "inline" (run the agent loop) and
 * "trigger" (call the Render Workflows SDK + exit).
 */
export function bundleCronAgents(bundle: BundlePick): {
  inline: ManifestAgentLite[];
  trigger: ManifestAgentLite[];
} {
  const inline: ManifestAgentLite[] = [];
  const trigger: ManifestAgentLite[] = [];
  for (const agent of manifestAgents(bundle)) {
    for (const rt of agent.runtimes ?? []) {
      if (rt.kind !== "cron") continue;
      if (rt.via === "workflow") trigger.push(agent);
      else inline.push(agent);
    }
  }
  return { inline, trigger };
}

export function bundleManifestYaml(bundle: BundlePick): string {
  return stringifyYaml(bundle.manifest, {
    lineWidth: 100,
    minContentWidth: 40,
    aliasDuplicateObjects: false,
  });
}

/**
 * Returns the set of runtime kinds the bundle declares across all
 * agents, restricted to v1-supported kinds (web/worker/cron). Workflows
 * agents — present in the manifest but not Blueprintable — don't get a
 * generated entrypoint.
 */
export function bundleRuntimeKinds(bundle: BundlePick): Set<BundleRuntimeKind> {
  const out = new Set<BundleRuntimeKind>();
  for (const kind of bundle.runtimeKinds) {
    if (kind === "web" || kind === "worker" || kind === "cron") out.add(kind);
  }
  return out;
}

export function bundleWebEntry(): string {
  return `import "dotenv/config";
import { defineFromConfig, enrichDeploymentInfo, toDeploymentInfo } from "@render-harness/registry";
import { serveWeb } from "@render-harness/web";

const configPath = "./render-harness.yaml";

const { agentsById, config, packs } = await defineFromConfig({ configPath });

// enrichDeploymentInfo layers in wizardServiceUrl, repoLocator,
// envSchema (with isSet annotations), and renderService — everything
// the operator UI's Agents + Config tabs need. All fields are
// best-effort; missing pieces just hide the corresponding affordances.
const deployment = await enrichDeploymentInfo(toDeploymentInfo(config), configPath, {
  config,
  packs,
});

const port = Number(process.env.PORT ?? 8080);

await serveWeb({
  agents: agentsById,
  port,
  ui: config.shared?.ui ?? false,
  deployment,
});
`;
}

export function bundleWorkerEntry(): string {
  return `import "dotenv/config";
import { defineFromConfig } from "@render-harness/registry";
import { startWorkerAndWait } from "@render-harness/runtime-worker";

const { agentsById } = await defineFromConfig({
  configPath: "./render-harness.yaml",
});

await startWorkerAndWait({
  agent: async (job) => {
    const found = agentsById[job.agentName];
    if (!found) {
      throw new Error(\`worker: agent "\${job.agentName}" not registered in this bundle\`);
    }
    return found;
  },
});
`;
}

export function bundleCronEntry(): string {
  return `import "dotenv/config";
import { defineFromConfig } from "@render-harness/registry";
import { runCronFromRegistryAndExit } from "@render-harness/runtime-cron";

const agentId = process.env.HARNESS_AGENT_ID ?? "";
const { agentsById } = await defineFromConfig({
  configPath: "./render-harness.yaml",
});

await runCronFromRegistryAndExit({
  agents: agentsById,
  agentId,
});
`;
}

/**
 * Cron-trigger entrypoint. Runs on a Render Cron service whose start
 * command is \`node dist/cron-trigger.js\`. The emitter sets
 * \`WORKFLOW_TASK_REF\` to the task identifier and \`RENDER_API_KEY\` as
 * a deploy-time secret. The trigger does the minimum work to start the
 * workflow run and exits — the actual agent loop runs in the Workflow
 * service.
 */
export function bundleCronTriggerEntry(): string {
  return `import "dotenv/config";
import { triggerAgentWorkflow } from "@render-harness/runtime-workflows";

const taskRef = process.env.WORKFLOW_TASK_REF;
const agentId = process.env.HARNESS_AGENT_ID;
if (!taskRef || !agentId) {
  console.error(
    "cron-trigger: WORKFLOW_TASK_REF and HARNESS_AGENT_ID env vars are required",
  );
  process.exit(2);
}

try {
  const result = await triggerAgentWorkflow({
    taskRef,
    agentName: agentId,
    agentVersion: "cron-triggered",
    metadata: { source: "cron-trigger" },
  });
  console.log(
    JSON.stringify({
      triggered: { taskRef, runId: result.runId, taskRunId: result.taskRunId },
    }),
  );
  process.exit(0);
} catch (err) {
  console.error(
    "cron-trigger failed:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
`;
}

/**
 * Workflows-service entrypoint. The bundle's single Workflow service
 * runs \`node dist/workflows.js\`; this file registers every workflow-
 * mode agent in the bundle as one \`task()\`. New agents added to the
 * manifest become new tasks automatically — Render rebuilds the
 * service on push and discovers the registrations on boot.
 */
export function bundleWorkflowsEntry(): string {
  return `import "dotenv/config";
import { task } from "@renderinc/sdk/workflows";
import { defineFromConfig, isWorkflowTaskAgent } from "@render-harness/registry";
import { runAgentStep } from "@render-harness/runtime-workflows";

const { agentsById, config } = await defineFromConfig({
  configPath: "./render-harness.yaml",
});

interface TaskInput {
  runId?: string;
  approvedToolCallIds?: string[];
}

for (const entry of config.agents) {
  if (!isWorkflowTaskAgent(entry)) continue;
  const agent = agentsById[entry.id];
  if (!agent) continue;
  task(
    { name: entry.id },
    async function agentStep(input: TaskInput = {}) {
      const runId = input.runId ?? globalThis.crypto.randomUUID();
      const result = await runAgentStep({
        agent,
        runId,
        ...(input.approvedToolCallIds && input.approvedToolCallIds.length > 0
          ? { approvedToolCallIds: input.approvedToolCallIds }
          : {}),
      });
      // On checkpoint, the task self-recurses so the Workflows UI shows
      // a chain of subtask rows.
      if (result.status === "checkpoint") {
        // biome-ignore lint/correctness/noSelfAssign: avoid TS complaining about implicit any
        const next: TaskInput = { runId };
        return await agentStep(next);
      }
      return result;
    },
  );
}
`;
}

export interface BundleTsupOpts {
  kinds: Set<BundleRuntimeKind>;
  hasCronTrigger: boolean;
  hasWorkflowTasks: boolean;
}

export function bundleTsupConfig(opts: BundleTsupOpts): string {
  const entryMap: Array<[string, string]> = [];
  for (const k of [...opts.kinds].sort()) {
    entryMap.push([k, `src/${k}.ts`]);
  }
  if (opts.hasCronTrigger) {
    entryMap.push(["cron-trigger", "src/cron-trigger.ts"]);
  }
  if (opts.hasWorkflowTasks) {
    entryMap.push(["workflows", "src/workflows.ts"]);
  }
  const entries = entryMap
    .map(([k, p]) => `    ${JSON.stringify(k)}: ${JSON.stringify(p)}`)
    .join(",\n");
  return `import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
${entries},
  },
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
`;
}

export interface BundlePackageJsonOpts {
  agentName: string;
  description: string;
  kinds: Set<BundleRuntimeKind>;
  capabilities: ReadonlyArray<string>;
  harnessRoot: string | null;
  /** True if any agent in the bundle is a workflow task (or any cron is via:workflow). */
  hasWorkflowTasks: boolean;
  /** True if any cron in the bundle uses via:workflow (cron-trigger services). */
  hasCronTrigger: boolean;
  /** True if any cron in the bundle uses the default inline mode. */
  hasInlineCron: boolean;
}

export function bundlePackageJson(opts: BundlePackageJsonOpts): string {
  const deps: Record<string, string> = {
    "@render-harness/core": linkSpec("core", opts.harnessRoot),
    "@render-harness/registry": linkSpec("registry", opts.harnessRoot),
    // dotenv is imported at the top of every runtime entry so the
    // scaffolded `.env` loads automatically in local dev. In production
    // Render injects env vars natively and dotenv is a no-op.
    dotenv: "^16.4.5",
  };
  if (opts.kinds.has("web")) {
    // Bundles always use the multi-tenant `@render-harness/web` stack
    // (it's the only one that exposes the agents map). The UI mount is
    // controlled by `shared.ui` in the manifest at runtime.
    deps["@render-harness/web"] = linkSpec("web", opts.harnessRoot);
    deps["@render-harness/ui"] = linkSpec("ui", opts.harnessRoot);
  }
  if (opts.kinds.has("worker")) {
    deps["@render-harness/runtime-worker"] = linkSpec("runtime-worker", opts.harnessRoot);
  }
  // Inline-mode cron pulls runtime-cron; trigger-mode cron + workflows
  // pull runtime-workflows + the Render SDK. A bundle may need both.
  if (opts.hasInlineCron) {
    deps["@render-harness/runtime-cron"] = linkSpec("runtime-cron", opts.harnessRoot);
  }
  if (opts.hasWorkflowTasks || opts.hasCronTrigger) {
    deps["@render-harness/runtime-workflows"] = linkSpec("runtime-workflows", opts.harnessRoot);
    deps["@renderinc/sdk"] = "^0.5.0";
  }
  for (const pack of opts.capabilities) {
    deps[pack] = linkForCapability(pack, opts.harnessRoot);
  }
  // Stable dep order so tests / snapshots stay deterministic.
  const sortedDeps = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  );

  const scripts: Record<string, string> = {
    build: "tsup",
    typecheck: "tsc --noEmit",
    // docker compose wrappers — db + KV. The Node services live on the
    // host so workflows-dev's local task socket is reachable without
    // Docker-in-Docker. See README.md for the full topology.
    "db:up": "docker compose up -d",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d",
    // One-shot deploy to Render via the REST API. Reads
    // render-harness.yaml, provisions every resource (db, KV, web,
    // worker, crons, workflow service), persists service ids in
    // .render-deploy.lock.json for idempotent re-runs.
    //
    // NB: named `render:deploy` (not `deploy`) because pnpm has its
    // own built-in `pnpm deploy` for package publishing.
    "render:deploy": "render-harness-deploy",
    "render:deploy:dry-run": "render-harness-deploy --dry-run",
  };

  // Per-service dev scripts (long-running OR one-shot — same shape).
  // The combined `dev` script below picks the long-running ones.
  //
  // Each entry file imports `dotenv/config` at the top so the
  // scaffolded `.env` is loaded automatically at boot. In production,
  // Render sets env vars natively and `dotenv/config` finds no .env
  // and silently no-ops — safe to ship.
  const longRunningDevs: string[] = [];
  if (opts.kinds.has("web")) {
    scripts["dev:web"] = "tsx src/web.ts";
    longRunningDevs.push("dev:web");
  }
  if (opts.kinds.has("worker")) {
    scripts["dev:worker"] = "tsx src/worker.ts";
    longRunningDevs.push("dev:worker");
  }
  if (opts.hasWorkflowTasks) {
    // `render workflows dev` boots the local task server and runs the
    // workflows.ts entry inside it. Requires the Render CLI 2.11.0+ on
    // the host. Web/worker reach this via the SDK with
    // `RENDER_USE_LOCAL_DEV=true` set in .env.
    scripts["dev:workflows"] = "render workflows dev -- tsx src/workflows.ts";
    longRunningDevs.push("dev:workflows");
  }
  // One-shot scripts — listed for ergonomics, not in `dev`. Each cron
  // entry exits on success; the user invokes them manually for testing.
  if (opts.hasInlineCron) {
    // HARNESS_AGENT_ID env required. Document in the dev:cron:note hint.
    scripts["dev:cron"] = "tsx src/cron.ts";
    scripts["dev:cron:note"] =
      "echo 'Set HARNESS_AGENT_ID=<agent-id> before running dev:cron (one-shot script).'";
  }
  if (opts.hasCronTrigger) {
    scripts["dev:cron-trigger"] = "tsx src/cron-trigger.ts";
    scripts["dev:cron-trigger:note"] =
      "echo 'Set HARNESS_AGENT_ID=<agent-id> + WORKFLOW_TASK_REF=<slug/agent> before running dev:cron-trigger.'";
  }

  // Combined `dev` — only emit when there's more than one long-running
  // service to coordinate. Bundles with a single long-running service
  // skip the combined script and the concurrently dep entirely; users
  // run the one `dev:*` script directly.
  if (longRunningDevs.length > 1) {
    const flags = longRunningDevs.map((s) => `'npm:${s}'`).join(" ");
    const names = longRunningDevs.map((s) => s.replace("dev:", "")).join(",");
    scripts.dev = `concurrently --kill-others-on-fail --names ${names} ${flags}`;
  }

  const devDependencies: Record<string, string> = {
    "@types/node": "^25.6.2",
    tsup: "^8.5.1",
    tsx: "^4.21.0",
    typescript: "^6.0.3",
  };
  if (longRunningDevs.length > 1) {
    // Only need concurrently when there's more than one long-running
    // service to coordinate. Single-service bundles can skip it.
    devDependencies.concurrently = "^9.1.0";
  }

  const pkg = {
    name: opts.agentName,
    version: "0.0.1",
    private: true,
    type: "module",
    description: opts.description,
    scripts,
    dependencies: sortedDeps,
    devDependencies,
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function linkSpec(pkgShortName: string, harnessRoot: string | null): string {
  if (harnessRoot) return `link:${harnessRoot}/packages/${pkgShortName}`;
  // Published-deps path. Pinned to the same version range the harness
  // repo currently ships. The bundle plan ships the harness on npm
  // ahead of bundle adoption; until then, use --harness-root locally.
  return "^0.1.0";
}

function linkForCapability(pkgName: string, harnessRoot: string | null): string {
  if (!harnessRoot) return "^0.1.0";
  // Cap packs live under packages/capabilities/.
  const tail = pkgName.split("/").pop();
  if (!tail) return "^0.1.0";
  return `link:${harnessRoot}/packages/capabilities/${tail}`;
}

export interface BundleEnvExampleOpts {
  manifest: BundlePick["manifest"];
  bundleSlug: string;
  hasWorkflowTasks: boolean;
  /** True when the bundle's `shared.ui` is true — adds UI auth env vars. */
  hasUi: boolean;
}

interface ManifestEnvVar {
  name: string;
  description?: string;
  default?: string;
  secret?: boolean;
}

/**
 * Build the bundle's `.env` (and `.env.example`). Bundle-derived
 * constants are pre-filled — the user only fills in real secrets like
 * API keys. Pairs with the scaffolder's `docker-compose.yml` (Postgres
 * creds match) and the workflow-mode dev story (RENDER_USE_LOCAL_DEV
 * pre-set so the SDK targets `render workflows dev`).
 *
 * Returned shape (newline-separated, ready for fs.writeFile).
 */
export function bundleEnvExample(opts: BundleEnvExampleOpts): string {
  const lines: string[] = [
    "# ──────────────────────────────────────────────────────────────",
    "# Local dev env for this bundle. Most values are pre-filled.",
    "# Only the entries marked `# fill in` are real secrets you need.",
    "# Production deploys lift these through the Render Blueprint.",
    "# ──────────────────────────────────────────────────────────────",
    "",
    "# State primitives (match docker-compose.yml — `pnpm db:up`):",
    "DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres",
    "KV_URL=redis://127.0.0.1:56379",
    "",
    "# Model provider — fill in",
    "ANTHROPIC_API_KEY=",
  ];

  if (opts.hasUi) {
    lines.push(
      "",
      "# Operator UI auth (browser at http://127.0.0.1:8080/ui).",
      "# WEB_API_KEY is the bearer-token the API + UI login form check;",
      "# UI_COOKIE_SECRET signs the browser session cookie. Both should",
      "# be real secrets in production — these `demo`/`local-dev-...`",
      "# defaults are fine for local testing only.",
      "WEB_API_KEY=demo",
      "UI_COOKIE_SECRET=local-dev-only-replace-in-production",
    );
  }

  if (opts.hasWorkflowTasks) {
    lines.push(
      "",
      "# Render Workflows (workflow-mode agents). RENDER_USE_LOCAL_DEV=true",
      "# tells the SDK to target your local `render workflows dev` server",
      "# (running under `pnpm dev:workflows`) instead of api.render.com.",
      "RENDER_USE_LOCAL_DEV=true",
      `WORKFLOW_SLUG=${opts.bundleSlug}-workflows`,
      "",
      "# Render Workflows requires an API key even in local-dev mode — fill in",
      "RENDER_API_KEY=",
    );
  }

  const envSchema = (opts.manifest as { envSchema?: ManifestEnvVar[] }).envSchema;
  if (envSchema?.length) {
    lines.push("", "# Manifest-declared env vars:");
    for (const v of envSchema) {
      // Description goes on its own comment line; secrets get a clear
      // "fill in" hint so the user knows what to actually edit.
      if (v.description) {
        for (const desc of v.description.trim().split("\n")) {
          lines.push(`# ${desc}`);
        }
      }
      const value = v.default ?? "";
      const trailer = v.secret && !value ? "      # fill in" : "";
      lines.push(`${v.name}=${value}${trailer}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export interface BundleReadmeOpts {
  agentName: string;
  description: string;
  bundle: BundlePick;
  packageManager: PackageManager;
  kinds: Set<BundleRuntimeKind>;
  hasWorkflowTasks: boolean;
  hasCronTrigger: boolean;
  hasInlineCron: boolean;
}

export function bundleReadme(opts: BundleReadmeOpts): string {
  const runner = opts.packageManager === "yarn" ? "yarn" : `${opts.packageManager} run`;
  const cronAgents = cronAgentIds(opts.bundle);
  const firstCronAgent = cronAgents[0];

  const layoutLines: string[] = [];
  if (opts.kinds.has("web")) layoutLines.push("  web.ts                    # serveWeb({ agents: agentsById })");
  if (opts.kinds.has("worker")) layoutLines.push("  worker.ts                 # startWorkerAndWait + agent resolver");
  if (opts.hasInlineCron) layoutLines.push("  cron.ts                   # one-shot; dispatches via HARNESS_AGENT_ID");
  if (opts.hasCronTrigger) layoutLines.push("  cron-trigger.ts           # one-shot; calls render.workflows.runTask + exits");
  if (opts.hasWorkflowTasks) layoutLines.push("  workflows.ts              # registers every workflow-mode agent as a task");

  const longRunningServices: string[] = [];
  if (opts.kinds.has("web")) longRunningServices.push("web");
  if (opts.kinds.has("worker")) longRunningServices.push("worker");
  if (opts.hasWorkflowTasks) longRunningServices.push("workflows-dev (via render CLI)");

  return `# ${opts.agentName}

${opts.description}

This project was scaffolded from the **${opts.bundle.slug}** gallery bundle — a sealed multi-agent template. Edit the per-agent files in \`src/\` to change behavior; \`render-harness.yaml\` describes the deployment shape.

## Layout

\`\`\`
render-harness.yaml         # bundle manifest (V2 schema, ${manifestAgentCount(opts.bundle)} agents)
docker-compose.yml          # local Postgres + Key Value
src/
  <agent-id>.ts             # one per bundled agent — defineAgent({...})
${layoutLines.join("\n")}
\`\`\`

## Run locally

Prereqs:
- Node 22+, ${opts.packageManager}, Docker (for db + KV)${opts.hasWorkflowTasks ? "\n- Render CLI 2.11.0+ (\`brew install render\`) for workflow-mode agents" : ""}

1. Open \`.env\` and fill in the entries marked \`# fill in\` — \`ANTHROPIC_API_KEY\`${opts.hasWorkflowTasks ? ", `RENDER_API_KEY`" : ""}, plus any manifest-declared secrets. Everything else (database URL, KV URL, workflow slug, local-dev flag) is already set for you.

2. Bring up state primitives:

\`\`\`sh
${runner} db:up
\`\`\`

3. Boot all long-running services (${longRunningServices.join(" + ")}) in parallel:

\`\`\`sh
${runner} dev
\`\`\`

   Runs \`${runner} dev:web\`${opts.kinds.has("worker") ? `, \`${runner} dev:worker\`` : ""}${opts.hasWorkflowTasks ? `, and \`${runner} dev:workflows\` (which wraps \`render workflows dev\`)` : ""} concurrently. Ctrl-C stops everything.

4. Test it:

\`\`\`sh
curl -X POST http://127.0.0.1:8080/runs \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer demo' \\
  -d '{"agentName":"chat","input":"hello"}'
\`\`\`

   Or open \`http://127.0.0.1:8080/ui\` for the operator UI.

${
    opts.hasInlineCron && firstCronAgent
      ? `### Running a cron entry one-shot

Inline cron jobs are billed-per-invocation. Trigger one manually for testing:

\`\`\`sh
HARNESS_AGENT_ID=${firstCronAgent} ${runner} dev:cron
\`\`\`

`
      : ""
  }${
    opts.hasCronTrigger
      ? `### Triggering a workflow-mode cron one-shot

\`\`\`sh
HARNESS_AGENT_ID=<agent-id> WORKFLOW_TASK_REF=${opts.bundle.slug}-workflows/<agent-id> \\
  ${runner} dev:cron-trigger
\`\`\`

`
      : ""
  }## Deploy

Generate the Blueprint:

\`\`\`sh
npx @render-harness/registry build render-harness.yaml --output render.yaml
\`\`\`

Commit and click the Deploy-to-Render badge. The Blueprint creates: 1 Postgres + 1 Key Value + 1 web + 1 worker${opts.hasInlineCron ? " + N inline cron services" : ""}${opts.hasCronTrigger ? " + N cron-trigger services" : ""}.

${
    opts.hasWorkflowTasks
      ? `### One Dashboard step after Blueprint deploy

Render Workflows aren't yet Blueprintable. After the first deploy lands, create one Workflow service in the Dashboard:

- **Name**: \`${opts.bundle.slug}-workflows\`
- **Repo**: link to this repo
- **Build**: \`corepack enable && pnpm install --frozen-lockfile && pnpm --filter ${opts.agentName} build\`
- **Start**: \`node dist/workflows.js\`

It will host every workflow-mode agent in this bundle as one Workflow task. Tasks auto-register on service boot, so adding agents later is just a push.
`
      : ""
  }`;
}

function manifestAgentCount(bundle: BundlePick): number {
  const agents = (bundle.manifest as { agents?: unknown[] }).agents;
  return Array.isArray(agents) ? agents.length : 0;
}

function cronAgentIds(bundle: BundlePick): string[] {
  const agents = (bundle.manifest as {
    agents?: Array<{ id?: string; runtimes?: Array<{ kind?: string }> }>;
  }).agents;
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((a) => a.runtimes?.some((r) => r.kind === "cron"))
    .map((a) => a.id)
    .filter((id): id is string => typeof id === "string");
}

export function bundleDockerCompose(_answers: Answers): string {
  return `services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: postgres
    ports: ["55432:5432"]
    volumes:
      - bundle-pg:/var/lib/postgresql/data

  valkey:
    image: valkey/valkey:8
    ports: ["56379:6379"]

volumes:
  bundle-pg: {}
`;
}
