## my-agent

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/<owner>/my-agent)

> Replace this paragraph with a one-liner about what your agent does.

This is a [Render agent harness](https://github.com/render-examples/render-harness) entry. End users deploy via the Deploy-to-Render badge above; you (the author) iterate locally, regenerate `render.yaml` with `pnpm build`, and commit.

## Local development

```sh
pnpm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY (and DATABASE_URL if not using compose)

# Bring up Postgres + Valkey (matches Render Managed Postgres + Key Value):
docker compose -f path/to/render-harness/compose.yaml up -d

pnpm dev
```

The entry is configured by [`render-harness.yaml`](./render-harness.yaml). Edit that file to change the agent's prompt, model, MCP servers, capability packs, or runtime topology. Then regenerate `render.yaml`:

```sh
pnpm build:bp     # writes render.yaml from render-harness.yaml
pnpm build:check  # CI-friendly: exit non-zero if render.yaml is stale
```

## Deploying

End users click the Deploy-to-Render badge above. Render reads the committed `render.yaml`, prompts for the env vars, and provisions services. If you change the YAML, regenerate and commit `render.yaml` so the next click stays in sync.

## Adding capabilities

Pull in first-party capability packs as regular npm deps:

```sh
pnpm add @render-harness/cap-search-exa
```

Then reference them in `render-harness.yaml`:

```yaml
capabilities:
  - pack: "@render-harness/cap-search-exa"
    config:
      defaultMaxResults: 10
```

The pack contributes tools, MCP servers, skills, and any required env vars. Re-run `pnpm build:bp` so the new env requirements land in `render.yaml`.

## Publishing to the registry

1. Push this repo to GitHub.
2. Capture the commit SHA: `git rev-parse HEAD`.
3. Open a PR to [`render-harness-index`](https://github.com/render-examples/render-harness-index) adding your entry's `name`, `description`, `repo`, `ref` (the SHA), and optional `categories`.
