import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentDefinition, ConversationId, Logger, Pool } from "@render-harness/core";
import {
  createConversation,
  findActiveRunForConversation,
  loadConversation,
  loadRun,
  type UserId,
} from "@render-harness/core";
import {
  type CapabilityRef,
  type ConnectorContribution,
  type ConnectorEnqueueConversationArgs,
  type ConnectorEnqueueResult,
  type ConnectorEnqueueRunArgs,
  type ConnectorWebCtx,
  interpolateTree,
  loadPacks,
  makePackContext,
  parseHarnessConfigYaml,
} from "@render-harness/registry";
import { enqueueRun as enqueueWorkerRun } from "@render-harness/runtime-worker";
import type { Hono } from "hono";
import type { PgBoss } from "pg-boss";
import { registerConnectorRoutes } from "./routes/connectors.js";

export type ConnectorMountConfig =
  | CapabilityRef[]
  | "from-config"
  | {
      refs?: CapabilityRef[];
      configPath?: string;
      entryRoot?: string;
      entryName?: string;
      env?: NodeJS.ProcessEnv;
    };

interface MountConnectorsArgs {
  app: Hono;
  connectors: ConnectorMountConfig;
  pool: Pool;
  boss: PgBoss;
  queue: string;
  logger: Logger;
  agents: Record<string, AgentDefinition>;
  pathPrefix: string;
}

interface MountedConnector {
  contribution: ConnectorContribution;
  ctx: ConnectorWebCtx;
}

export async function mountConnectorsIfAvailable(args: MountConnectorsArgs): Promise<void> {
  const resolved = await resolveConnectorConfig(args.connectors);
  if (resolved.refs.length === 0) {
    args.logger.info("connectors: no capability refs configured");
    return;
  }

  const loadedPacks = await loadPacks({ entryRoot: resolved.entryRoot, refs: resolved.refs });
  const mounted = new Map<string, MountedConnector>();
  for (const loaded of loadedPacks) {
    if (!loaded.pack.connectors) continue;
    const packCtx = makePackContext(loaded, resolved.entryName, resolved.env);
    const contributions = await loaded.pack.connectors(packCtx);
    for (const contribution of contributions) {
      const key = contribution.key ?? connectorKey(loaded.pack.name);
      if (mounted.has(key)) {
        throw new Error(`connector key "${key}" is registered by more than one capability pack`);
      }
      mounted.set(key, {
        contribution,
        ctx: buildConnectorWebCtx({
          pool: args.pool,
          boss: args.boss,
          queue: args.queue,
          logger: args.logger.child({ connector: key }),
          agents: args.agents,
          config: loaded.ref.config ?? {},
        }),
      });
    }
  }

  if (mounted.size === 0) {
    args.logger.info("connectors: no connector contributions found");
    return;
  }

  registerConnectorRoutes(args.app, {
    connectors: mounted,
    logger: args.logger,
    pathPrefix: args.pathPrefix,
  });
  args.logger.info({ keys: Array.from(mounted.keys()) }, "connectors: mounted");
}

async function resolveConnectorConfig(config: ConnectorMountConfig): Promise<{
  refs: CapabilityRef[];
  entryRoot: string;
  entryName: string;
  env: NodeJS.ProcessEnv;
}> {
  if (Array.isArray(config)) {
    return {
      refs: config,
      entryRoot: process.cwd(),
      entryName: process.env.RENDER_HARNESS_ENTRY_NAME ?? "agent",
      env: process.env,
    };
  }
  if (config === "from-config") {
    const configPath = resolve(
      process.cwd(),
      process.env.RENDER_HARNESS_CONFIG ?? "render-harness.yaml",
    );
    return resolveFromConfigPath(configPath, process.env);
  }
  if (config.configPath) {
    const configPath = isAbsolute(config.configPath)
      ? config.configPath
      : resolve(process.cwd(), config.configPath);
    const fromFile = await resolveFromConfigPath(configPath, config.env ?? process.env);
    return {
      ...fromFile,
      ...(config.entryRoot ? { entryRoot: config.entryRoot } : {}),
      ...(config.entryName ? { entryName: config.entryName } : {}),
      ...(config.refs ? { refs: config.refs } : {}),
    };
  }
  return {
    refs: config.refs ?? [],
    entryRoot: config.entryRoot ?? process.cwd(),
    entryName: config.entryName ?? process.env.RENDER_HARNESS_ENTRY_NAME ?? "agent",
    env: config.env ?? process.env,
  };
}

async function resolveFromConfigPath(configPath: string, env: NodeJS.ProcessEnv) {
  const raw = await readFile(configPath, "utf8");
  const parsed = parseHarnessConfigYaml(raw);
  const lookup = (name: string) => env[name];
  const refs =
    parsed.capabilities?.map((ref) =>
      ref.config
        ? {
            ...ref,
            config: interpolateTree(ref.config, lookup, {
              errorPrefix: `render-harness.yaml capabilities[${ref.pack}].config`,
            }),
          }
        : ref,
    ) ?? [];
  return {
    refs,
    entryRoot: dirname(configPath),
    entryName: parsed.name,
    env,
  };
}

function buildConnectorWebCtx(args: {
  pool: Pool;
  boss: PgBoss;
  queue: string;
  logger: Logger;
  agents: Record<string, AgentDefinition>;
  config: Record<string, unknown>;
}): ConnectorWebCtx {
  const resolveAgent = (agentName?: string) => {
    const selected =
      agentName ?? stringConfig(args.config.agent) ?? Object.keys(args.agents)[0] ?? "";
    const agent = args.agents[selected];
    if (!agent) throw new Error(`connector target agent "${selected}" is not loaded`);
    return agent;
  };
  return {
    pool: args.pool,
    logger: args.logger,
    config: args.config,
    resolveAgent,
    enqueueRun: (runArgs) =>
      enqueueConnectorRun({
        ...runArgs,
        pool: args.pool,
        boss: args.boss,
        queue: args.queue,
      }),
    enqueueIntoConversation: (runArgs) =>
      enqueueIntoConversation({
        ...runArgs,
        pool: args.pool,
        boss: args.boss,
        queue: args.queue,
      }),
  };
}

async function enqueueConnectorRun(
  args: ConnectorEnqueueRunArgs & {
    pool: Pool;
    boss: PgBoss;
    queue: string;
  },
): Promise<ConnectorEnqueueResult> {
  const runId = args.runId ?? crypto.randomUUID();
  const existing = await loadRun(args.pool, runId);
  if (existing) return { status: "duplicate", runId, existing };
  await enqueueWorkerRun({
    pool: args.pool,
    boss: args.boss,
    queue: args.queue,
    agentName: args.agentName,
    agentVersion: args.agentVersion,
    ...(args.userId ? { userId: args.userId } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.initialContent !== undefined ? { initialContent: args.initialContent } : {}),
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    runId,
  });
  return {
    status: "enqueued",
    runId,
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
  };
}

async function enqueueIntoConversation(
  args: ConnectorEnqueueConversationArgs & {
    pool: Pool;
    boss: PgBoss;
    queue: string;
  },
): Promise<ConnectorEnqueueResult> {
  const conversationArgs: {
    id: ConversationId;
    userId?: UserId | null;
    agentName: string;
    agentVersion: string;
    title?: string | null;
    metadata?: Record<string, unknown>;
  } = {
    id: args.conversationId,
    agentName: args.agentName,
    agentVersion: args.agentVersion,
  };
  if (args.userId !== undefined) conversationArgs.userId = args.userId;
  if (args.title !== undefined) conversationArgs.title = args.title;
  if (args.conversationMetadata !== undefined)
    conversationArgs.metadata = args.conversationMetadata;
  await ensureConversation(args.pool, conversationArgs);
  const active = await findActiveRunForConversation(args.pool, args.conversationId);
  if (active) {
    return { status: "active_run_exists", conversationId: args.conversationId, activeRun: active };
  }
  return enqueueConnectorRun(args);
}

async function ensureConversation(
  pool: Pool,
  args: {
    id: ConversationId;
    userId?: UserId | null;
    agentName: string;
    agentVersion: string;
    title?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const existing = await loadConversation(pool, args.id);
  if (existing) return existing;
  try {
    return await createConversation(pool, {
      id: args.id,
      ...(args.userId !== undefined ? { userId: args.userId } : {}),
      agentName: args.agentName,
      agentVersion: args.agentVersion,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    });
  } catch (err) {
    const raced = await loadConversation(pool, args.id);
    if (raced) return raced;
    throw err;
  }
}

function connectorKey(packName: string): string {
  return packName.replace(/^@[^/]+\//, "");
}

function stringConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
