# @render-harness/cap-render

First-party capability pack that wires Render's hosted MCP server (`https://mcp.render.com/mcp`) into a Render Agent Harness agent. Lets agents manage Render workspaces — list services, trigger deploys, read logs, manage env vars, create databases and Key Value instances.

The MCP catalog itself is owned by Render. This pack handles the harness-side wiring:

- Registers the Render MCP as an HTTP-transport MCP server with bearer auth.
- Ships three skills (`render-overview`, `render-deploy-flow`, `render-logs-and-debug`) for the agent to load on demand.
- Declares `RENDER_API_KEY` in the envSchema so the wizard and the operator UI surface the missing key.
- Exports a `RENDER_MCP_MUTATING_TOOLS` constant listing the 12 destructive Render MCP tools, so agents can paste it into `permissions.requireApproval` for HITL on mutations.

## Install

```sh
pnpm add @render-harness/cap-render
```

## Configure

Add to your `render-harness.yaml`:

```yaml
capabilities:
  - pack: "@render-harness/cap-render"
    config:
      # Optional — override the env var name holding the API key.
      apiKeyEnv: RENDER_API_KEY
      # Optional — override for staging or self-hosted Render MCP endpoints.
      baseUrl: https://mcp.render.com/mcp
```

And set:

```sh
RENDER_API_KEY=<get one at https://dashboard.render.com/u/settings#api-keys>
```

That's it. Tools become available to the agent as `cap-render.render.<tool-name>` after boot.

## Human-in-the-loop on destructive operations

Render's MCP exposes destructive tools (delete service, create/update Postgres, etc.). For any non-trivial agent, you want the harness to pause for human review before each mutation.

Use the pack's exported list to wire `permissions.requireApproval`:

```yaml
shared:
  permissions:
    requireApproval:
      # These are the 12 entries in RENDER_MCP_MUTATING_TOOLS as of cap-render@0.5.0.
      # The names below are the fully-namespaced *exposed* names the harness sees
      # after the loader wraps the pack's MCP server (`render` → `cap-render__render`)
      # and core sanitizes the result (hyphens → underscores).
      - cap_render__render__create_web_service
      - cap_render__render__update_web_service
      - cap_render__render__delete_service
      - cap_render__render__create_postgres
      - cap_render__render__update_postgres
      - cap_render__render__delete_postgres
      - cap_render__render__create_keyvalue
      - cap_render__render__update_keyvalue
      - cap_render__render__delete_keyvalue
      - cap_render__render__update_environment_variables
      - cap_render__render__create_environment_variable
      - cap_render__render__delete_environment_variable
```

If you previously had the deploy-agent's bare `render__create_web_service` style in `permissions.requireApproval`, those names came from declaring `mcpServers:` directly on the agent (no pack indirection). The pack-routed names above are different — copy the new list verbatim when migrating.

Why declare these on the agent rather than the pack? The `CapabilityPack` contract has no `permissions` slot today — pack-level permissions would let `cap-render` inject these directly, but that's a future platform change (tracked in the wave-2 roadmap). For now the constant is documentation: `import { RENDER_MCP_MUTATING_TOOLS } from "@render-harness/cap-render"` in tooling, or check the list into your agent config.

## Config keys

| Key | Default | Notes |
|---|---|---|
| `apiKeyEnv` | `"RENDER_API_KEY"` | Override when the deployment already has the key under a different name. |
| `baseUrl` | `"https://mcp.render.com/mcp"` | Override for staging or a self-hosted Render MCP endpoint. |

## Env schema

| Var | Required | Secret | Notes |
|---|---|---|---|
| `RENDER_API_KEY` | yes | yes | Render workspace API key. Generate at https://dashboard.render.com/u/settings#api-keys. |

When `RENDER_API_KEY` is unset, the pack logs a `console.warn` at boot and registers no MCP server — agents in the same bundle that don't use cap-render keep working. (Mirrors `cap-search-exa`'s safe-default behavior.)

## Skills

| Name | When to use |
|---|---|
| `render-overview` | First time the agent touches a Render workspace — what 'service', 'deploy', 'project', and 'environment' mean. |
| `render-deploy-flow` | Deploying a new service, redeploying, or debugging a failed deploy. |
| `render-logs-and-debug` | Diagnosing 502/503s, unexpected restarts, OOMs, dependency errors. |

Loaded on demand via the built-in `load_skill` tool — they're not in every system prompt by default.

## Versioning

This pack ships its own patch line per the `@render-harness/*` independent-versioning policy. The first release is `0.5.0`, matching the family minor. See `docs/AGENTS.md` for the full versioning model.
