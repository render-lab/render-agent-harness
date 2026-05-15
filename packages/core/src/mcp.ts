import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "pino";
import { serializeError } from "./errors.js";
import type { McpServerConfig, ToolDefinition } from "./types.js";

export interface McpToolHandle {
  /** Name as exposed to the model (server-prefixed to avoid collisions). */
  exposedName: string;
  /** Original tool name on the server. */
  serverName: string;
  /** Owning server config name. */
  server: string;
  definition: ToolDefinition;
  call: (input: unknown, signal: AbortSignal) => Promise<McpToolCallResult>;
}

export interface McpToolCallResult {
  content: string;
  isError: boolean;
}

export interface ConnectedMcp {
  servers: Map<string, ConnectedServer>;
  tools: McpToolHandle[];
  closeAll: () => Promise<void>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport:
    | InstanceType<typeof StdioClientTransport>
    | InstanceType<typeof StreamableHTTPClientTransport>;
}

const TOOL_SEPARATOR = "__";

/**
 * Connect to every configured MCP server, discover tools, and return a flat
 * list of {@link McpToolHandle}s the loop can dispatch against. Tool names are
 * prefixed with the server name (e.g. `render__list_services`) so two servers
 * can expose the same tool name without colliding.
 *
 * Caller is responsible for invoking `closeAll()` when the run finishes.
 */
export async function connectMcpServers(args: {
  configs: McpServerConfig[];
  logger: Logger;
}): Promise<ConnectedMcp> {
  const { configs, logger } = args;
  const servers = new Map<string, ConnectedServer>();
  const tools: McpToolHandle[] = [];

  for (const cfg of configs) {
    const child = logger.child({ mcpServer: cfg.name });
    try {
      const conn = await connectOne(cfg, child);
      servers.set(cfg.name, conn);
      const list = await conn.client.listTools();
      for (const tool of list.tools) {
        if (cfg.allowTools && !cfg.allowTools.includes(tool.name)) continue;
        const exposedName = exposedToolName(cfg.name, tool.name);
        tools.push({
          exposedName,
          serverName: tool.name,
          server: cfg.name,
          definition: {
            name: exposedName,
            description: tool.description ?? "",
            inputSchema: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
              type: "object",
              properties: {},
            },
            source: `mcp:${cfg.name}`,
          },
          call: async (input, signal) => {
            const res = await conn.client.callTool(
              { name: tool.name, arguments: (input as Record<string, unknown>) ?? {} },
              undefined,
              { signal },
            );
            const text = collectMcpText(res.content as unknown);
            return { content: text, isError: !!res.isError };
          },
        });
      }
      child.info({ toolCount: list.tools.length }, "mcp server connected");
    } catch (err) {
      child.error({ err: serializeError(err) }, "mcp server connection failed; skipping");
    }
  }

  return {
    servers,
    tools,
    closeAll: async () => {
      for (const s of servers.values()) {
        await s.client.close().catch(() => {});
      }
    },
  };
}

async function connectOne(cfg: McpServerConfig, logger: Logger): Promise<ConnectedServer> {
  const client = new Client({ name: "render-harness", version: "0.1.0" }, { capabilities: {} });

  if (cfg.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
    });
    await client.connect(transport as never);
    logger.debug({ command: cfg.command }, "mcp stdio connected");
    return { name: cfg.name, client, transport };
  }

  const httpOpts = cfg.headers ? { requestInit: { headers: cfg.headers } } : {};
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), httpOpts);
  await client.connect(transport as never);
  logger.debug({ url: cfg.url }, "mcp http connected");
  return { name: cfg.name, client, transport };
}

function collectMcpText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c && typeof c === "object") {
        const block = c as { type?: string; text?: string };
        if (block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
      }
      return JSON.stringify(c);
    })
    .join("\n");
}

export function exposedToolName(server: string, name: string): string {
  return `${sanitize(server)}${TOOL_SEPARATOR}${sanitize(name)}`;
}

export function parseExposedToolName(exposed: string): { server: string; name: string } | null {
  const idx = exposed.indexOf(TOOL_SEPARATOR);
  if (idx === -1) return null;
  return {
    server: exposed.slice(0, idx),
    name: exposed.slice(idx + TOOL_SEPARATOR.length),
  };
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}
