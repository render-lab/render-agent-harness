/**
 * cap-search-tavily — wires up the Tavily AI-search MCP for any
 * harness entry that wants quick, citation-friendly web answers.
 *
 * Usage in render-harness.yaml:
 *
 *   capabilities:
 *     - pack: "@render-harness/cap-search-tavily"
 *
 * Surfaces:
 *   - One MCP server (stdio transport) named "tavily".
 *   - One skill (skills/web-search-tavily.md).
 *   - envSchema entry for TAVILY_API_KEY.
 *
 * Config keys:
 *   - `apiKeyEnv` (string, default "TAVILY_API_KEY")
 *   - `command` (string, default "npx") — override for self-hosted MCP runners.
 *   - `package` (string, default "tavily-mcp") — the npm package run by `npx -y`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig, SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "skills");

interface TavilyConfig {
  apiKeyEnv?: string;
  command?: string;
  package?: string;
}

function readConfig(ctx: PackContext) {
  const cfg = ctx.config as TavilyConfig;
  return {
    apiKeyEnv: cfg.apiKeyEnv ?? "TAVILY_API_KEY",
    command: cfg.command ?? "npx",
    pkg: cfg.package ?? "tavily-mcp",
  };
}

const pack = definePack({
  name: "cap-search-tavily",
  version: "0.1.0",
  envSchema: [
    {
      name: "TAVILY_API_KEY",
      required: true,
      secret: true,
      description: "API key for Tavily search (https://tavily.com).",
    },
  ],
  mcpServers(ctx: PackContext): McpServerConfig[] {
    const cfg = readConfig(ctx);
    const apiKey = ctx.env(cfg.apiKeyEnv);
    if (!apiKey) {
      throw new Error(
        `cap-search-tavily: env var ${cfg.apiKeyEnv} is not set. Set it before building or starting the agent.`,
      );
    }
    return [
      {
        name: "tavily",
        transport: "stdio",
        command: cfg.command,
        args: ["-y", cfg.pkg],
        env: { TAVILY_API_KEY: apiKey },
      },
    ];
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    return [
      {
        name: "web-search-tavily",
        description: "Use Tavily for fast, citation-friendly AI search.",
        whenToUse:
          "When you want a concise, summarized answer with sources rather than raw search results. Tavily returns one synthesized response with citations.",
        contentPath: join(SKILLS_DIR, "web-search-tavily.md"),
      },
    ];
  },
});

export default pack;
