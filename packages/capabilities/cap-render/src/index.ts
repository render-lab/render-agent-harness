/**
 * @render-harness/cap-render
 *
 * First-party capability pack that wires Render's hosted MCP server
 * (https://mcp.render.com/mcp) into a harness agent. Lets agents
 * manage Render workspaces — list services, trigger deploys, read
 * logs, manage env vars, create databases/key-value, etc.
 *
 * The MCP catalog is owned by Render (not this pack); we just register
 * the HTTP transport with bearer auth and ship skills + a curated
 * "mutating tools" list that consumer agents should paste into their
 * `permissions.requireApproval` for HITL on destructive operations.
 *
 * Usage in render-harness.yaml:
 *
 *   capabilities:
 *     - pack: "@render-harness/cap-render"
 *       config:
 *         # Optional — override the env var name holding the API key.
 *         apiKeyEnv: RENDER_API_KEY
 *         # Optional — override for staging or self-hosted MCP endpoints.
 *         baseUrl: https://mcp.render.com/mcp
 *
 * Surfaces:
 *   - One MCP server (HTTP transport) named "render" — namespaced by
 *     the loader to "cap-render.render".
 *   - Three skills (skills/render-overview.md, skills/render-deploy-flow.md,
 *     skills/render-logs-and-debug.md) loadable via the built-in
 *     `load_skill` tool.
 *   - envSchema entry for RENDER_API_KEY.
 *
 * Deployment requirements:
 *   - Generate an API key at https://dashboard.render.com/u/settings#api-keys.
 *   - Set RENDER_API_KEY on the harness service.
 *
 * HITL pattern (recommended):
 *   The Render MCP exposes many destructive tools. Consumer agents
 *   should list these under `permissions.requireApproval` so the
 *   harness pauses for human review before each mutation. The pack
 *   exports the list as `RENDER_MCP_MUTATING_TOOLS` for convenience:
 *
 *     // render-harness.yaml
 *     shared:
 *       permissions:
 *         requireApproval:
 *           # Mirrors RENDER_MCP_MUTATING_TOOLS from
 *           # @render-harness/cap-render. Names are the fully-
 *           # namespaced exposed form (cap_render__render__<tool>) the
 *           # harness sees at runtime — see README for the derivation.
 *           - cap_render__render__create_web_service
 *           - cap_render__render__delete_service
 *           ...
 *
 *   This list is documentation today, not enforcement. A future
 *   pack-level `permissions` slot on the CapabilityPack contract would
 *   let cap-render inject these directly; for now agents declare them.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig, SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/ is one level under the package root, so skills/ is one above.
const SKILLS_DIR = join(HERE, "..", "skills");

const DEFAULT_API_KEY_ENV = "RENDER_API_KEY";
const DEFAULT_BASE_URL = "https://mcp.render.com/mcp";

/**
 * Curated list of Render MCP tools that mutate workspace state, in
 * the exact form they appear as `exposedName` after the harness
 * namespaces them. Agents using `cap-render` should add these to
 * their `permissions.requireApproval` list so the harness pauses for
 * human review before each mutation.
 *
 * **Why these particular strings?** The exposed name is produced by:
 *
 *   1. The loader wraps the pack's MCP server name `render` as
 *      `namespacedMcpServerName("cap-render", "render")` →
 *      `"cap-render__render"`.
 *   2. Core's `exposedToolName("cap-render__render", <mcp tool>)`
 *      runs both halves through `sanitize()`, which replaces every
 *      character that isn't `[A-Za-z0-9_]` with `_`. The hyphens in
 *      the pack-namespaced server name become underscores.
 *   3. The exposed name `permissions.requireApproval` matches against
 *      is therefore `cap_render__render__<mcp_tool_name>`.
 *
 * The deploy-agent example's bare `render__create_web_service` form
 * is the right form *when the agent declares `mcpServers:` directly*
 * with the server name `render` (no pack indirection). When you
 * switch the agent to use this pack, the names change — use this
 * constant so you don't have to derive them by hand.
 *
 * The MCP tool names themselves (`create_web_service` etc., without
 * the `render__` prefix on Render's side) are derived empirically
 * from the deploy-agent example's HITL list. Keep in sync if
 * Render's MCP catalog grows new destructive tools.
 */
export const RENDER_MCP_MUTATING_TOOLS = [
  "cap_render__render__create_web_service",
  "cap_render__render__update_web_service",
  "cap_render__render__delete_service",
  "cap_render__render__create_postgres",
  "cap_render__render__update_postgres",
  "cap_render__render__delete_postgres",
  "cap_render__render__create_keyvalue",
  "cap_render__render__update_keyvalue",
  "cap_render__render__delete_keyvalue",
  "cap_render__render__update_environment_variables",
  "cap_render__render__create_environment_variable",
  "cap_render__render__delete_environment_variable",
] as const;

export type RenderMcpMutatingTool = (typeof RENDER_MCP_MUTATING_TOOLS)[number];

/**
 * The bare Render MCP tool names (no harness namespacing). Useful
 * when an agent declares `mcpServers:` directly with server name
 * `render` instead of going through this pack — that's what the
 * legacy `examples/deploy-agent` YAML did before adopting the pack.
 * These match the form Render's MCP returns from `tools/list`.
 */
export const RENDER_MCP_MUTATING_TOOL_NAMES_RAW = [
  "create_web_service",
  "update_web_service",
  "delete_service",
  "create_postgres",
  "update_postgres",
  "delete_postgres",
  "create_keyvalue",
  "update_keyvalue",
  "delete_keyvalue",
  "update_environment_variables",
  "create_environment_variable",
  "delete_environment_variable",
] as const;

interface RenderConfig {
  apiKeyEnv?: string;
  baseUrl?: string;
}

function readConfig(ctx: PackContext): Required<RenderConfig> {
  const cfg = ctx.config as RenderConfig;
  return {
    apiKeyEnv:
      typeof cfg.apiKeyEnv === "string" && cfg.apiKeyEnv.length > 0
        ? cfg.apiKeyEnv
        : DEFAULT_API_KEY_ENV,
    baseUrl:
      typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0 ? cfg.baseUrl : DEFAULT_BASE_URL,
  };
}

const pack = definePack({
  name: "cap-render",
  version: pkg.version,
  envSchema: [
    {
      name: DEFAULT_API_KEY_ENV,
      required: true,
      secret: true,
      description:
        "Render workspace API key. Get one at https://dashboard.render.com/u/settings#api-keys. Used as a bearer token to the hosted Render MCP at https://mcp.render.com/mcp.",
    },
  ],
  mcpServers(ctx: PackContext): McpServerConfig[] {
    const cfg = readConfig(ctx);
    const apiKey = ctx.env(cfg.apiKeyEnv);
    if (!apiKey) {
      // Skip MCP server registration when the key is unset. Throwing
      // here would crash every service in the bundle on boot — even
      // ones that don't use cap-render — because defineFromConfig
      // walks every pack for every agent. Mirror cap-search-exa's
      // safe-default: warn and return [], so the pack's tools are
      // simply absent until the operator sets the key.
      console.warn(
        `cap-render: env var ${cfg.apiKeyEnv} is not set; skipping Render MCP registration. Set it to enable Render tools.`,
      );
      return [];
    }
    return [
      {
        name: "render",
        transport: "http",
        url: cfg.baseUrl,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    ];
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    return [
      {
        name: "render-overview",
        description:
          "Orient yourself in a Render workspace — services, deploys, env vars, the project/environment hierarchy.",
        whenToUse:
          "Read this first whenever a user asks you to do anything with their Render account. It explains what 'service', 'deploy', 'project', and 'environment' mean and how they relate.",
        contentPath: join(SKILLS_DIR, "render-overview.md"),
      },
      {
        name: "render-deploy-flow",
        description:
          "Deploy a repo to Render — when to use create_web_service vs a Blueprint, how to interpret deploy statuses, what to do when a deploy fails.",
        whenToUse:
          "When the user wants to deploy a new service, redeploy an existing one, or debug a failed deploy. Pair this with the render-overview skill if you haven't oriented yourself yet.",
        contentPath: join(SKILLS_DIR, "render-deploy-flow.md"),
      },
      {
        name: "render-logs-and-debug",
        description:
          "Pull build/runtime logs from a Render service and diagnose common failures (missing env vars, port binding, OOM, dependency errors).",
        whenToUse:
          "When the user reports a deploy failure, a 502/503 from their service, an unexpected restart, or any 'why is X not working' question about a Render service.",
        contentPath: join(SKILLS_DIR, "render-logs-and-debug.md"),
      },
    ];
  },
});

export default pack;
