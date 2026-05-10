/**
 * cap-browser-browserbase — wires Browserbase's headless-browser MCP
 * for any harness entry that needs to drive a real browser (login
 * flows, JS-heavy pages, scraping behind paywalls / SPAs).
 *
 * Usage in render-harness.yaml:
 *
 *   capabilities:
 *     - pack: "@render-harness/cap-browser-browserbase"
 *
 * Surfaces:
 *   - One MCP server `browserbase` (stdio transport).
 *   - One skill (skills/browserbase.md).
 *   - envSchema entries for BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.
 *
 * Config keys:
 *   - `apiKeyEnv` (string, default "BROWSERBASE_API_KEY")
 *   - `projectIdEnv` (string, default "BROWSERBASE_PROJECT_ID")
 *   - `command` (string, default "npx")
 *   - `package` (string, default "@browserbasehq/mcp")
 *
 * Browserbase is a hosted browser pool, so this pack does NOT declare
 * any extra Render services — sessions live on Browserbase's side.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig, SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "skills");

interface BrowserbaseConfig {
  apiKeyEnv?: string;
  projectIdEnv?: string;
  command?: string;
  package?: string;
}

function readConfig(ctx: PackContext) {
  const cfg = ctx.config as BrowserbaseConfig;
  return {
    apiKeyEnv: cfg.apiKeyEnv ?? "BROWSERBASE_API_KEY",
    projectIdEnv: cfg.projectIdEnv ?? "BROWSERBASE_PROJECT_ID",
    command: cfg.command ?? "npx",
    pkg: cfg.package ?? "@browserbasehq/mcp",
  };
}

const pack = definePack({
  name: "cap-browser-browserbase",
  version: "0.1.0",
  envSchema: [
    {
      name: "BROWSERBASE_API_KEY",
      required: true,
      secret: true,
      description: "API key for Browserbase (https://browserbase.com).",
    },
    {
      name: "BROWSERBASE_PROJECT_ID",
      required: true,
      secret: false,
      description: "Project ID in your Browserbase workspace.",
    },
  ],
  mcpServers(ctx: PackContext): McpServerConfig[] {
    const cfg = readConfig(ctx);
    const apiKey = ctx.env(cfg.apiKeyEnv);
    const projectId = ctx.env(cfg.projectIdEnv);
    if (!apiKey || !projectId) {
      throw new Error(
        `cap-browser-browserbase: missing ${cfg.apiKeyEnv} or ${cfg.projectIdEnv}. Set both before starting the agent.`,
      );
    }
    return [
      {
        name: "browserbase",
        transport: "stdio",
        command: cfg.command,
        args: ["-y", cfg.pkg],
        env: {
          BROWSERBASE_API_KEY: apiKey,
          BROWSERBASE_PROJECT_ID: projectId,
        },
      },
    ];
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    return [
      {
        name: "browserbase",
        description: "Drive a real browser via Browserbase when scraping isn't enough.",
        whenToUse:
          "When the page requires JS execution, login, click flows, or screenshots that aren't possible with HTTP scraping.",
        contentPath: join(SKILLS_DIR, "browserbase.md"),
      },
    ];
  },
});

export default pack;
