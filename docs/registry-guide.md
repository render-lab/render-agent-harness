# Config registry guide

Three audiences use the registry. Pick yours:

- **[End users](#end-user-deploying-someone-elses-agent)** — you want to deploy an existing agent on Render.
- **[Authors](#author-publishing-your-own-agent)** — you want to publish a new agent to the registry.
- **[Pack contributors](#pack-contributor-publishing-a-capability-pack)** — you want to ship a capability pack so other entries can use it.

After the role-specific sections, there's a [reference](#reference) covering every `render-harness.yaml` field, the first-party packs, common patterns per runtime, local dev, and troubleshooting.

---

## End user: deploying someone else's agent

You're not writing code. You want a working agent.

1. Browse the discovery site (links from the [registry-index README](../registry-index/README.md)).
2. Click an entry's **Deploy to Render** badge.
3. Render reads the entry's committed `render.yaml`, prompts you for required env vars (model API key, any service-specific secrets), and provisions services.
4. Wait for the build to finish, then visit the assigned `*.onrender.com` URL.

That's it. No CLI, no clone, no `git`. The badge URL is the entire interface.

If the entry needs Postgres or Key Value, the Blueprint already declares them — Render provisions everything in the same project automatically.

---

## Author: publishing your own agent

You'll need: Node 22+, pnpm 10+, Docker (for local Postgres + Valkey via [`compose.yaml`](../compose.yaml)), a GitHub repo to publish to.

### 1. Scaffold from the template

The [`templates/render-harness-entry/`](../templates/render-harness-entry/) directory is the canonical starter. Copy it into a new repo:

```sh
# Eventually this'll be a GitHub "Use this template" repo. For now:
cp -r path/to/render-harness/templates/render-harness-entry my-agent
cd my-agent
git init
```

The template includes:

- `render-harness.yaml` — your entry's declarative config.
- `agent/index.ts` — calls `defineFromConfig()` to assemble the agent at boot.
- `src/main.ts` — runtime entrypoint (defaults to `runtime-web`; swap based on your `runtimes[]` block).
- `package.json` with `build` running `render-harness-build && tsup`.

### 2. Edit `render-harness.yaml`

Open `render-harness.yaml` and change:

- `name` — a unique slug, lowercase + hyphens.
- `description` — one line, ≤280 chars.
- `agent.systemPrompt` — what your agent does.
- `runtimes[]` — pick the [right runtime](#runtime-patterns) for your shape.
- `model` — provider + model id.
- `mcpServers[]` — third-party MCPs you want.
- `capabilities[]` — first-party or community packs.
- `envSchema[]` — extra env vars users must supply at deploy time.

### 3. Add capability packs (optional)

Pull packs in as regular npm deps:

```sh
pnpm add @render-harness/cap-search-exa @render-harness/cap-memory-pg
```

Then reference them in `render-harness.yaml`:

```yaml
capabilities:
  - pack: "@render-harness/cap-search-exa"
    config:
      defaultMaxResults: 10
  - pack: "@render-harness/cap-memory-pg"
```

Pack-contributed env vars (`EXA_API_KEY`, etc.) automatically merge into your effective `envSchema` — you don't redeclare them.

### 4. Iterate locally

```sh
pnpm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY and any pack-required keys

# Bring up local Postgres + Valkey, matching Render Managed Postgres + Key Value:
docker compose -f path/to/render-harness/compose.yaml up -d

pnpm dev    # runs src/main.ts via tsx; reload manually after edits
```

Hit your agent locally:

```sh
curl -sS http://localhost:8080/runs \
  -H 'content-type: application/json' \
  -d '{"input":"Hello!"}' | jq
```

### 5. Generate `render.yaml`

When you're happy, regenerate the Blueprint:

```sh
pnpm build:bp     # writes render.yaml from render-harness.yaml
```

The output prints a list of every env var the deploy will prompt for, plus a Deploy-to-Render badge snippet for your README. Paste the snippet near the top of your README.

`pnpm build:check` (used by CI) exits non-zero if `render.yaml` is stale relative to `render-harness.yaml`, so you can never push a drifted Blueprint.

### 6. Commit and push

```sh
git add .
git commit -m "Initial my-agent entry"
git remote add origin git@github.com:<owner>/my-agent.git
git push -u origin main

git rev-parse HEAD   # capture the SHA — you'll need it for the index PR
```

### 7. Submit to the index

Open a PR to [`registry-index/index.json`](../registry-index/index.json) (eventually its own `render-harness-index` repo) adding:

```json
{
  "name": "my-agent",
  "description": "Your one-line description.",
  "repo": "https://github.com/<owner>/my-agent",
  "ref": "<the 40-char SHA from git rev-parse>",
  "categories": ["chat", "demo"]
}
```

CI runs two checks:

1. The shape of `index.json` (against the Zod schema).
2. Fetches `render-harness.yaml` from your repo at the pinned SHA and validates it.

A maintainer reviews and merges. Your entry shows up on the discovery site.

### 8. Updating an entry

Push new commits to your repo. Open a follow-up PR to the index changing only the `ref` field. Existing deployments keep running the old version — end users redeploy when they want the update.

---

## Pack contributor: publishing a capability pack

You're shipping a reusable extension other entries can pull in. Examples: a new MCP wiring, a `LocalToolHandler` that wraps a SaaS API, a memory backend.

### Pack contract

A capability pack is an npm package whose default export is a `CapabilityPack`:

```ts
import { definePack, type PackContext } from "@render-harness/registry";
import type { McpServerConfig, SkillMetadata, LocalToolHandler } from "@render-harness/core";

export default definePack({
  name: "cap-my-thing",          // matches the npm package name; used to namespace tools/MCP
  version: "0.1.0",
  envSchema: [
    {
      name: "MY_THING_API_KEY",
      required: true,
      secret: true,
      description: "API key for my thing.",
    },
  ],
  mcpServers(ctx: PackContext): McpServerConfig[] {
    const apiKey = ctx.env("MY_THING_API_KEY");
    if (!apiKey) throw new Error("MY_THING_API_KEY is not set");
    return [{ name: "thing", transport: "http", url: "...", headers: { Authorization: `Bearer ${apiKey}` } }];
  },
  localTools(ctx: PackContext): LocalToolHandler[] {
    // optional: TS tool handlers contributed at runtime
    return [];
  },
  skills(ctx: PackContext): SkillMetadata[] {
    // optional: markdown skills the agent can load via the built-in load_skill tool
    return [];
  },
  renderServices(ctx: PackContext) {
    // optional: extra Render services to merge into the entry's render.yaml
    // (e.g. a sidecar pserv). Called only at build time; never at runtime.
    return [];
  },
});
```

Each callback receives a `PackContext`:

- `ctx.config` — the user's `config:` block from `render-harness.yaml`.
- `ctx.env(name)` — looks up an env var (`process.env`-backed at both build and runtime).
- `ctx.entryName` — the slug from the entry's YAML, useful as a default namespace.

### Project layout

Mirror what `packages/capabilities/cap-search-exa` does:

```text
my-pack/
  src/index.ts         # default-exports definePack({...})
  skills/              # optional: SKILL.md files referenced from skills() callback
  package.json         # main: "./dist/index.js"; lists @render-harness/registry as a dep
  tsconfig.json
  tsup.config.ts
  README.md
```

### Naming conventions

- npm name: `@<scope>/cap-<short-name>` (e.g. `@render-harness/cap-search-exa`).
- `pack.name`: the npm package's short name (`cap-search-exa`).
- Tool names: don't pre-namespace; the loader prepends `<pack.name>.` automatically (so a tool named `web_search` becomes `cap-search-exa.web_search` in the agent).
- MCP server names: same — declare the short name; loader namespaces it.
- Env var names: pack-specific prefixes are encouraged (`EXA_API_KEY`, `FIRECRAWL_API_KEY`).

### Publishing

Standard npm flow: `pnpm publish --access public`. Add the `render-harness-cap` keyword to `package.json` so your pack shows up in npm search.

Entries pull it in: `pnpm add @your/cap-thing`, then reference it under `capabilities[]`.

---

## Reference

### `render-harness.yaml` fields

| Field | Required | Notes |
|---|---|---|
| `schemaVersion` | yes | `1` for now. |
| `name` | yes | Slug; lowercase + hyphens; 1–63 chars. |
| `description` | yes | One-liner; ≤280 chars. |
| `harnessVersion` | yes | npm-style range (e.g. `^0.1`). |
| `license` | no | SPDX id. |
| `author` | no | Free-form. |
| `categories` | no | Tag slugs for the discovery site. |
| `agent` | yes | Either `{ kind: builtin, ref: chat, systemPrompt }` or `{ kind: custom, entrypoint }`. |
| `runtimes[]` | yes | At least one of `web` / `worker` / `cron` / `workflows`. Each kind appears at most once. |
| `model` | yes | `{ provider: anthropic | openai-compat, model, baseURL?, apiKeyEnv?, thinking? }`. |
| `mcpServers[]` | no | Stdio (`command` + `args`) or HTTP (`url` + `headers`). `${VAR}` placeholders resolve from env at boot/build. |
| `capabilities[]` | no | npm packages implementing `CapabilityPack`. |
| `permissions` | no | `{ requireApproval, allowedTools, deniedTools }`. |
| `budget` | no | Per-run caps: `maxIterations`, `maxWallSeconds`, `maxTokens`, `maxCostUsd`. |
| `sampling` | no | `temperature`, `topP`, `maxOutputTokens`. |
| `envSchema[]` | no | Extra env vars the user must supply. |

### Runtime patterns

The Blueprint emitter auto-derives the right Render service shape from `runtimes[]`:

| `runtimes[]` | Output | When |
|---|---|---|
| `[{ kind: web }]` | Single web service + Postgres | Demo / sub-30s sync agent |
| `[{ kind: cron, schedule }]` | Cron service + Postgres | Scheduled audit / batch |
| `[{ kind: web }, { kind: worker }]` | Public web shell + worker pserv + Postgres + Key Value | Production multi-tenant; matches `render.private.yaml` |
| `[{ kind: workflows }]` | Dashboard checklist (Workflows aren't yet Blueprintable) | Long-running, durable, HITL |

Don't combine `cron` with `worker` (cron is single-shot). The schema rejects duplicate kinds.

### First-party capability packs

| Pack | What it adds | Required env |
|---|---|---|
| `@render-harness/cap-search-exa` | Exa web-search MCP + skill | `EXA_API_KEY` |
| `@render-harness/cap-search-tavily` | Tavily AI-search MCP + skill | `TAVILY_API_KEY` |
| `@render-harness/cap-scrape-firecrawl` | Firecrawl MCP + `scrape_and_store` LocalToolHandler (persists to Postgres) + skill | `FIRECRAWL_API_KEY` |
| `@render-harness/cap-memory-pg` | `memory.write` / `memory.search` over `pg_trgm`; lazy schema bootstrap | (uses existing `DATABASE_URL`) |
| `@render-harness/cap-browser-browserbase` | Browserbase MCP for headless-browser automation | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` |

Pack-contributed env vars are merged into your effective `envSchema`. Don't redeclare them in your YAML.

### `${VAR}` interpolation

In MCP server fields and capability `config` blocks, you can reference env vars:

```yaml
mcpServers:
  - name: render
    transport: http
    url: https://mcp.render.com/mcp
    headers:
      Authorization: "Bearer ${RENDER_API_KEY}"
      X-Optional: "${MAYBE:-default-value}"
```

- `${VAR}` — required; throws at boot if unset.
- `${VAR:-fallback}` — uses `fallback` when unset.
- `\${VAR}` — literal, no expansion.

### Local development

The harness ships a [`compose.yaml`](../compose.yaml) that brings up Postgres 17 + Valkey 8 on `127.0.0.1:55432` / `:56379`. Set `DATABASE_URL=postgres://harness:harness@127.0.0.1:55432/harness` (and `KV_URL=redis://127.0.0.1:56379` if your runtime needs KV).

Per-runtime dev scripts in your entry's `package.json`:

```jsonc
{
  "scripts": {
    "dev": "tsx src/main.ts"        // for runtime-web / cron
    // for runtime-worker:
    // "dev:worker": "tsx src/worker.ts",
    // for the multi-tenant production shape:
    // "dev:web": "tsx src/web.ts",
  }
}
```

### Build commands

| Command | What it does |
|---|---|
| `pnpm build:bp` | Generates `render.yaml` from `render-harness.yaml`. |
| `pnpm build:check` | Exits non-zero if `render.yaml` is stale. Use in CI. |
| `pnpm build:tsup` | Compiles TypeScript to `dist/`. |
| `pnpm build` | Both, in order: `render-harness-build && tsup`. |

### Custom TS agents (`agent.kind: custom`)

When the `chat` builtin isn't enough, write an `agent/index.ts` that default-exports an `AgentDefinition`:

```ts
import { defineAgent } from "@render-harness/core";
import type { LocalToolHandler } from "@render-harness/core";

export default defineAgent({
  name: "my-agent",
  version: "0.1.0",
  model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  systemPrompt: "...",
  localTools: [
    /* ... your handlers ... */
  ],
  // mcpServers, permissions, etc.
});
```

Reference it from `render-harness.yaml`:

```yaml
agent:
  kind: custom
  entrypoint: ./agent/index.ts
```

The YAML's `model`, `permissions`, `budget`, and `sampling` blocks overlay onto whatever the TS file produced — convenient for swapping models without touching code.

### Troubleshooting

**`render-harness-build` says my Blueprint is out of date.**
You edited `render-harness.yaml` (or upgraded a capability pack) and forgot to regenerate. Run `pnpm build:bp` and commit the new `render.yaml`.

**My capability pack throws `env var X is not set` at build time.**
Packs validate their required env vars when their callbacks fire. Set the missing vars in your shell (or `.env` file) before running `pnpm build:bp`. The build bin doesn't ship secrets into `render.yaml` — it just needs them to validate the pack will work at runtime.

**The discovery site shows my entry but the deploy fails immediately.**
Check that you committed the regenerated `render.yaml` after your last change. Render reads what's in git, not what's in your local working tree.

**My `runtimes[].kind: workflows` deploy is missing the workflow service.**
Render Workflows aren't yet Blueprintable (architecture verification 2). The build bin prints a Dashboard checklist; create the workflow service from the Render Dashboard following those steps.

**`exactOptionalPropertyTypes` errors when I write a custom agent.**
The harness uses `exactOptionalPropertyTypes: true`. Don't pass explicit `undefined` for optional fields — omit them entirely or use the `dropUndefined()` helper from `@render-harness/registry`.

**Pack tools have weird names like `cap-search-exa.web_search`.**
That's the namespacing rule: pack tool names are prefixed with the pack's name to avoid collisions when multiple packs ship a tool called `search`. Reference them by the namespaced name in `permissions.deniedTools` etc.
