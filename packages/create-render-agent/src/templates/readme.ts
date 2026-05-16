import { type Answers, isMultiRuntime, scriptRunner } from "../types.js";

/**
 * README.md for the scaffolded project. Includes a Deploy-to-Render badge
 * placeholder, local-dev instructions tailored to the chosen runtime(s),
 * and pointers to the registry guide.
 *
 * Commands use whichever package manager the user ran the wizard with
 * (detected via `npm_config_user_agent`); npm/pnpm/yarn/bun all work
 * because the package.json scripts use universal `npm:` prefixes in
 * `concurrently`.
 */
export function readme(answers: Answers): string {
  const pm = answers.packageManager;
  const run = scriptRunner(pm);
  const runtimeKinds = answers.runtimes.map((r) => r.kind);
  const runtimeBlurb = runtimeKindsBlurb(runtimeKinds);
  const uiBlurb = answers.ui
    ? "\n\nThe operator chat UI is mounted at <http://127.0.0.1:8080/login>. Sign in with the value you set for `WEB_API_KEY`."
    : "";
  const multi = isMultiRuntime(answers);
  const devNote = multi
    ? `\`${run} dev\` runs all ${runtimeKinds.length} runtimes (${runtimeKinds.join(
        ", ",
      )}) under \`concurrently\` with colour-coded prefixes. Use \`${run} dev:${runtimeKinds[0]}\` etc. to run one at a time.`
    : `\`${run} dev\` runs the runtime under \`tsx\` for fast iteration.`;

  return `## ${answers.agentName}

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/<owner>/${answers.agentName})

> ${answers.description}

This is a [Render agent harness](https://github.com/render-examples/render-harness) entry. Configuration lives in [\`render-harness.yaml\`](./render-harness.yaml).

## Runtime topology

${runtimeBlurb}

## Local development

Requires Docker (for Postgres + Valkey) and any Node 22+ package manager (npm, pnpm, yarn, bun — examples below use \`${pm}\`).
${harnessDepNote(answers)}
\`\`\`sh
${pm} install
# Edit .env — fill in ANTHROPIC_API_KEY (and WEB_API_KEY/UI_COOKIE_SECRET if you enabled the UI).
# Other values (DATABASE_URL, KV_URL) are pre-populated to match \`${run} db:up\`.
${run} db:up               # Postgres + Valkey via docker-compose
${run} dev
\`\`\`${uiBlurb}

${devNote}

Other datastore commands:

\`\`\`sh
${run} db:down    # stop containers (data preserved)
${run} db:reset   # nuke volumes and restart
${run} db:logs    # tail logs
\`\`\`

## Customizing the agent

Everything about the agent lives in [\`render-harness.yaml\`](./render-harness.yaml). The manifest declares one or more agents in an \`agents\` list and bundle-wide defaults under \`shared\`:

| Field | What to change |
|---|---|
| \`agents[<i>].agent.systemPrompt\` | This agent's persona / instructions. |
| \`shared.model.model\` | Swap to \`claude-opus-4-7\`, \`claude-haiku-4-5\`, etc. (each agent can override via its own \`model\`). |
| \`agents[<i>].mcpServers\` | Add an MCP server (stdio or http transport) to this agent. |
| \`agents[<i>].runtimes\` | Add/remove trigger surfaces for this agent; tweak cron schedule or worker queue. |
| \`agents[<i>].workflowTask\` | \`true\` registers this agent as a task on the bundle's Workflow service. |
| \`capabilities\` | Bundle-wide capability packs (see "Adding capabilities" below). |
| \`envSchema\` | Bundle-wide env vars surfaced at deploy time. |

Add a second agent by appending another entry to \`agents:\` — the scaffolder is single-agent by default, but the runtime + emitter already support multi-agent bundles. See the harness docs for the bundle authoring guide.

Edit the YAML, then restart the dev process to pick up changes. ${
    answers.ui
      ? "The operator UI at `/` shows the resolved agents under the **Agents** tab (read-only — editing prompts at runtime is intentionally not supported; agents are built at boot via `defineFromConfig`)."
      : "Agents are built at boot via `defineFromConfig`, so edits take effect on restart."
  }

## Regenerating render.yaml

After changing \`render-harness.yaml\`, regenerate \`render.yaml\` so the Render Blueprint reflects your config:

\`\`\`sh
${run} build:bp     # writes render.yaml from render-harness.yaml
${run} build:check  # CI-friendly: exit non-zero if render.yaml is stale
\`\`\`

## Deploying

End users click the Deploy-to-Render badge above. Render reads the committed \`render.yaml\`, prompts for env vars, and provisions services.

## Adding capabilities

Pull first-party packs in as regular npm deps and reference them in \`render-harness.yaml\`:

\`\`\`sh
${addCommand(pm)} @render-harness/cap-search-exa
\`\`\`

\`\`\`yaml
capabilities:
  - pack: "@render-harness/cap-search-exa"
\`\`\`

Then re-run \`${run} build:bp\` so the pack's env requirements land in \`render.yaml\`.
`;
}

function harnessDepNote(answers: Answers): string {
  if (answers.harnessRoot) {
    return `
> **Local-link mode.** This project's \`@render-harness/*\` deps are \`link:\` paths into \`${answers.harnessRoot}\`. Rebuild the harness packages (\`pnpm -r build\` from there) and rerun this project to pick up changes. To break the link, replace the \`link:\` paths in \`package.json\` with version ranges and re-install.
`;
  }
  return `
> **Heads-up.** This project's \`@render-harness/*\` deps point at published npm packages. If you cloned the harness repo and want to develop against local source, re-scaffold with \`--harness-root <path>\` to wire \`link:\` deps to your checkout.
`;
}

function addCommand(pm: Answers["packageManager"]): string {
  switch (pm) {
    case "yarn":
      return "yarn add";
    case "npm":
      return "npm install";
    case "pnpm":
      return "pnpm add";
    case "bun":
      return "bun add";
  }
}

function runtimeKindsBlurb(kinds: readonly string[]): string {
  const blurbs: Record<string, string> = {
    web: "- **web** — HTTP service, accepts run requests and streams responses (sub-30s synchronous shape).",
    cron: "- **cron** — scheduled, single-shot. Schedule expression lives in `render-harness.yaml`.",
    worker:
      "- **worker** — always-on queue consumer. Reads jobs from the pg-boss queue declared in `render-harness.yaml`.",
  };
  return kinds.map((k) => blurbs[k] ?? `- **${k}**`).join("\n");
}
