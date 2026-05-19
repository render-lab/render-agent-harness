# @render-harness/cap-render

## 0.6.0

### Minor Changes

- Coordinated 0.6.0 minor cut. Capability packs can now declare SQL migrations via a new `migrations` slot on the `CapabilityPack` contract; the harness applies them at boot before any agent code runs.

  **`@render-harness/core`** — new `MigrationFile` and `PackMigration` interface exports. `applyMigrations(pool, opts?)` gains an optional second argument: when `opts.packMigrations` is non-empty, pack-contributed migrations run after core migrations under the same advisory lock. Each pack migration runs in its own transaction; on success `(packName, id)` is recorded in a new `agent_pack_migrations` core table (added via new core migration `0005_pack_migrations.sql`), so subsequent boots skip already-applied entries cheaply. A failing pack migration aborts boot with an actionable error naming the pack + migration id, and rolls back its transaction so the DB isn't left half-migrated. `AgentDefinition` gains an optional `packMigrations?: PackMigration[]` field that `defineFromConfig` populates from loaded packs. The single-arg `applyMigrations(pool)` call site stays backward-compatible — existing code keeps working unchanged.

  **`@render-harness/contracts`** — no public-surface change; bumped to keep the family coordinated.

  **`@render-harness/registry`** — `CapabilityPack` contract gains an optional `migrations?: (ctx: PackContext) => MigrationFile[] | Promise<MigrationFile[]>` slot. The zod validator at `assertCapabilityPack` accepts the new field. `defineFromConfig` walks every loaded pack's `migrations` callback, prefixes each entry with `packName`, and surfaces the collected list on `AgentDefinition.packMigrations`. The runner dedupes by `(packName, id)`, so the same pack contributed across multiple agents in a bundle is applied once. `MigrationFile` and `PackMigration` are re-exported from `@render-harness/registry` for pack-author convenience.

  **`@render-harness/runtime-cron`, `runtime-web`, `runtime-worker`, `runtime-workflows`, `web`** — each runtime adapter now passes `{ packMigrations: agent.packMigrations ?? [] }` (or, for the multi-agent shapes, the merged flat list across all known agents) into `applyMigrations` at boot. The trigger-side `applyMigrations` call in `runtime-workflows/triggerAgentWorkflow` stays single-arg — it only needs core tables for the `ensureRun` insert that follows.

  **`create-render-agent`** — generated scaffold entries (`src/runtime/cron-entry.ts`, `worker-entry.ts`) call `applyMigrations(pool, { packMigrations: agent.packMigrations ?? [] })` instead of `applyMigrations(pool)`. New scaffolds inherit pack-migration support automatically; existing scaffolded deployments need to either re-scaffold or manually update the entry file.

  **Every published `@render-harness/cap-*` pack** — bumped to stay on the same 0.6 baseline. No behavioral change in the existing packs; the new `migrations` slot is opt-in.

  **Operators upgrading existing deployments** need to:
  1. Bump `harnessVersion` in `render-harness.yaml` to `"^0.6.0"`.
  2. Bump every `"@render-harness/*"` dep range in `package.json` to `"^0.6.0"`.
  3. If the deployment uses an old scaffolded entry, update the `applyMigrations(pool)` call to `applyMigrations(pool, { packMigrations: agent.packMigrations ?? [] })`. Without this, packs using `migrations` will silently have nothing applied.

  See `docs-site/src/content/docs/authoring-capability-packs.mdx#migrations` for the pack-author walkthrough and the [`docs/capabilities-shipping-plan.md`](docs/capabilities-shipping-plan.md) Phase 1.5 entry for the design rationale.

### Patch Changes

- Updated dependencies
  - @render-harness/registry@0.6.0

## 0.5.0

### Minor Changes

- Initial release. First-party capability pack that wires the hosted Render MCP (`https://mcp.render.com/mcp`) for managing Render workspaces — services, deploys, databases, env vars, logs.

  Surfaces:
  - One MCP server (HTTP transport) named `render` — namespaced by the loader to `cap-render.render`. Skipped at boot with a `console.warn` when `RENDER_API_KEY` is unset, mirroring `cap-search-exa`'s safe-default behavior so a missing key doesn't crash unrelated agents.
  - Three bundled skills (`render-overview`, `render-deploy-flow`, `render-logs-and-debug`) loadable via the built-in `load_skill` tool.
  - One env-schema entry for `RENDER_API_KEY`.
  - Exported `RENDER_MCP_MUTATING_TOOLS` constant listing the 12 known destructive Render MCP tools, so consumer agents can paste it into `permissions.requireApproval` for HITL. The list is documentation today — there's no pack-level `permissions` slot on `CapabilityPack` (yet); agents still declare `requireApproval` themselves.

  Config keys:
  - `apiKeyEnv` (string, default `"RENDER_API_KEY"`) — override the env var name to read for the bearer token.
  - `baseUrl` (string, default `"https://mcp.render.com/mcp"`) — override for staging or self-hosted Render MCP endpoints.

  Migration note for the existing `examples/deploy-agent` and `gallery/agents/deploy-agent`: the raw `mcpServers:` block is replaced with `capabilities: [{ pack: "@render-harness/cap-render" }]`. `permissions.requireApproval` stays declared on the agent (the pack constant exists for documentation; the agent author still copies it in).
