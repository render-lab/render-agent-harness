/**
 * cap-search-exa — wires up Exa's hosted MCP server (https://exa.ai)
 * for any harness entry that wants high-recall web search.
 *
 * Usage in render-harness.yaml:
 *
 *   capabilities:
 *     - pack: "@render-harness/cap-search-exa"
 *       version: "^0.1"
 *       config:
 *         defaultMaxResults: 10
 *
 * Surfaces:
 *   - One MCP server (HTTP transport) named "exa" — namespaced by the
 *     loader to "cap-search-exa.exa".
 *   - One skill (skills/web-search-exa.md) explaining when to reach
 *     for Exa vs other tools.
 *   - envSchema entry for EXA_API_KEY.
 *
 * Config keys:
 *   - `apiKeyEnv` (string, default "EXA_API_KEY") — env var name to
 *     read for the bearer token. Override if the entry already has
 *     another env var holding the key.
 *   - `baseUrl` (string, default "https://mcp.exa.ai/mcp") — override
 *     for self-hosted or staging Exa MCP endpoints.
 *   - `defaultMaxResults` (number) — passed through to Exa's tool args
 *     by way of an "Exa-Default-Max-Results" header. Optional.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig, SkillMetadata } from "@render-harness/core";
import { definePack, type PackContext } from "@render-harness/registry";
import pkg from "../package.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/ is one level under the package root, so skills/ is one above.
const SKILLS_DIR = join(HERE, "..", "skills");

interface ExaConfig {
  apiKeyEnv?: string;
  baseUrl?: string;
  defaultMaxResults?: number;
}

function readConfig(
  ctx: PackContext,
): Required<Pick<ExaConfig, "apiKeyEnv" | "baseUrl">> & ExaConfig {
  const cfg = ctx.config as ExaConfig;
  return {
    apiKeyEnv: cfg.apiKeyEnv ?? "EXA_API_KEY",
    baseUrl: cfg.baseUrl ?? "https://mcp.exa.ai/mcp",
    ...(cfg.defaultMaxResults !== undefined ? { defaultMaxResults: cfg.defaultMaxResults } : {}),
  };
}

const pack = definePack({
  name: "cap-search-exa",
  version: pkg.version,
  envSchema: [
    {
      name: "EXA_API_KEY",
      required: true,
      secret: true,
      description:
        "API key for Exa search (https://exa.ai). Used as a bearer token to the Exa MCP.",
    },
  ],
  mcpServers(ctx: PackContext): McpServerConfig[] {
    const cfg = readConfig(ctx);
    const apiKey = ctx.env(cfg.apiKeyEnv);
    if (!apiKey) {
      // Skip MCP server registration when the key is unset. Throwing here
      // would crash every service in the bundle on boot — even ones that
      // don't use Exa — because defineFromConfig walks every pack for
      // every agent. The warning surfaces the issue without trapping the
      // user in a crash loop; the Exa tools just won't be available
      // until they set the key.
      console.warn(
        `cap-search-exa: env var ${cfg.apiKeyEnv} is not set; skipping MCP server registration. Set it to enable Exa search.`,
      );
      return [];
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    if (cfg.defaultMaxResults !== undefined) {
      headers["Exa-Default-Max-Results"] = String(cfg.defaultMaxResults);
    }
    return [
      {
        name: "exa",
        transport: "http",
        url: cfg.baseUrl,
        headers,
      },
    ];
  },
  skills(_ctx: PackContext): SkillMetadata[] {
    return [
      {
        name: "web-search-exa",
        description: "Use Exa for high-recall, neural web search.",
        whenToUse:
          "When you need fresh web context, comparison shopping, or to find specific facts not in your training data. Prefer this over fetch_url unless you already have a specific URL.",
        contentPath: join(SKILLS_DIR, "web-search-exa.md"),
      },
    ];
  },
});

export default pack;
