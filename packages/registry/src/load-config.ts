/**
 * The runtime entry point for YAML-driven harness entries.
 *
 * Reads `render-harness.yaml`, resolves every agent (built-in or
 * custom entrypoint), loads any capability packs from the entry's
 * `node_modules`, and assembles a list of runnable
 * {@link AgentDefinition}s plus a lookup map keyed by agent id.
 *
 *   import { defineFromConfig } from "@render-harness/registry";
 *   const { agents, agentsById } = await defineFromConfig({
 *     configPath: "./render-harness.yaml",
 *     env: process.env,
 *   });
 *   // pass agentsById to serveWeb / startWorker / runCronFromRegistry.
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AgentDefinition,
  type Budget,
  defineAgent,
  type LocalToolHandler,
  type McpServerConfig,
  type ModelSpec,
  type OAuthProviderConfig,
  type Permissions,
  registerOAuthProvider,
  type SamplingParams,
  type SkillMetadata,
} from "@render-harness/core";
import { defineChatAgent } from "./builtin-chat.js";
import {
  type CapabilityPack,
  namespacedMcpServerName,
  namespacedToolName,
  type PackContext,
} from "./capability.js";
import { interpolateTree } from "./interpolate.js";
import { type LoadedPack, loadPacks, makePackContext } from "./load-pack.js";
import {
  type AgentEntryInput,
  type BudgetInput,
  type CapabilityRef,
  type HarnessConfig,
  type ModelSpecInput,
  type PermissionsInput,
  parseHarnessConfigYaml,
  type SamplingParamsInput,
} from "./schema.js";
import { dropUndefined } from "./util.js";

export interface DefineFromConfigOpts {
  /**
   * Path to the entry's `render-harness.yaml`. Relative paths resolve
   * against `process.cwd()` (matches every other CLI tool) unless an
   * `entryRoot` is supplied.
   */
  configPath: string;
  /**
   * Optional entry repo root. Defaults to the directory containing
   * `configPath`. Used to resolve `agent.entrypoint` and capability
   * pack node_modules.
   */
  entryRoot?: string;
  /** Env source. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface DefineFromConfigResult {
  /** One {@link AgentDefinition} per `agents[]` entry, in declaration order. */
  agents: AgentDefinition[];
  /**
   * Lookup map keyed by `agent.id`. Convenient for runtime registries
   * (`runtime-worker` resolver, `runtime-cron` registry mode, etc.).
   */
  agentsById: Record<string, AgentDefinition>;
  config: HarnessConfig;
  packs: LoadedPack[];
  /**
   * OAuth providers contributed by capability packs. Also registered
   * into core's process-level provider registry as a side-effect of
   * `defineFromConfig` so `runAgent`'s per-run `SecretsContext` finds
   * them without further wiring.
   */
  oauthProviders: OAuthProviderConfig[];
}

/**
 * Resolve a render-harness.yaml into a set of agent definitions plus a
 * lookup map. A "single-agent" entry is just a manifest with one item
 * in `agents[]` — same code path, no special case.
 */
export async function defineFromConfig(
  opts: DefineFromConfigOpts,
): Promise<DefineFromConfigResult> {
  const env = opts.env ?? process.env;
  const configAbs = isAbsolute(opts.configPath)
    ? opts.configPath
    : resolve(process.cwd(), opts.configPath);
  const entryRoot = opts.entryRoot ?? dirname(configAbs);

  const yamlText = await readFile(configAbs, "utf8");
  const rawConfig = parseHarnessConfigYaml(yamlText);
  const config = interpolateEnvSlots(rawConfig, env);

  const packs = await loadPacks(
    config.capabilities ? { entryRoot, refs: config.capabilities } : { entryRoot },
  );

  // Collect + register OAuth providers from any pack that contributes them.
  // Registration is a side-effect on the core's process-level registry so
  // `runAgent`'s per-run SecretsContext picks them up without further
  // wiring. The caller also gets the array so the web layer can mount
  // /connections routes for each one.
  const oauthProviders: OAuthProviderConfig[] = [];
  for (const loaded of packs) {
    if (!loaded.pack.oauthProviders) continue;
    const ctx = makePackContext(loaded, config.name, env);
    const providers = await loaded.pack.oauthProviders(ctx);
    for (const provider of providers) {
      registerOAuthProvider(provider);
      oauthProviders.push(provider);
    }
  }

  const agents: AgentDefinition[] = [];
  const agentsById: Record<string, AgentDefinition> = {};
  for (const entry of config.agents) {
    const base = await resolveAgentEntry(config, entry, entryRoot);
    const merged = await mergePackContributions(base, config, entry, packs, env);
    const finalAgent = defineAgent(merged);
    agents.push(finalAgent);
    agentsById[entry.id] = finalAgent;
  }

  return { agents, agentsById, config, packs, oauthProviders };
}

// ----------------------------------------------------------------------
// Per-agent resolver
// ----------------------------------------------------------------------

async function resolveAgentEntry(
  cfg: HarnessConfig,
  entry: AgentEntryInput,
  entryRoot: string,
): Promise<AgentDefinition> {
  const effective = effectiveAgentDefaults(cfg, entry);

  if (entry.agent.kind === "builtin") {
    return buildChatBuiltin(cfg, entry, effective);
  }

  // kind: custom — dynamic-import the entrypoint and trust the export.
  const entrypointAbs = resolve(entryRoot, entry.agent.entrypoint);
  const entryUrl = pathToFileURL(entrypointAbs).href;
  const mod = (await import(entryUrl)) as Record<string, unknown>;
  const exported = mod.default ?? mod.agent;
  if (!exported) {
    throw new Error(
      `agent "${entry.id}" entrypoint "${entry.agent.entrypoint}" does not export a default or named "agent" value`,
    );
  }
  const candidate = typeof exported === "function" ? await (exported as () => unknown)() : exported;
  if (!isAgentDefinitionShape(candidate)) {
    throw new Error(
      `agent "${entry.id}" entrypoint "${entry.agent.entrypoint}": export is not an AgentDefinition`,
    );
  }
  return overlayYamlFields(candidate, effective, entry.id);
}

function isAgentDefinitionShape(v: unknown): v is AgentDefinition {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.systemPrompt === "string";
}

/**
 * Per-agent effective defaults: agent-level override falls back to
 * `shared.*` for model / permissions / budget / sampling.
 */
interface AgentDefaults {
  model: ModelSpecInput;
  permissions: PermissionsInput | undefined;
  budget: BudgetInput | undefined;
  sampling: SamplingParamsInput | undefined;
}

function effectiveAgentDefaults(cfg: HarnessConfig, entry: AgentEntryInput): AgentDefaults {
  const model = entry.model ?? cfg.shared?.model;
  if (!model) {
    throw new Error(
      `agent "${entry.id}" has no model and shared.model is unset (schema should have rejected this)`,
    );
  }
  return {
    model,
    permissions: entry.permissions ?? cfg.shared?.permissions,
    budget: entry.budget ?? cfg.shared?.budget,
    sampling: entry.sampling ?? cfg.shared?.sampling,
  };
}

function overlayYamlFields(
  base: AgentDefinition,
  defaults: AgentDefaults,
  agentId: string,
): AgentDefinition {
  // Override the agent's `name` to match the bundle entry's id so the
  // runtime registry can look agents up by id. The TS-defined agent
  // may have used any name internally; what matters is what the runtime
  // sees.
  const out: AgentDefinition = { ...base, name: agentId };
  out.model = { ...base.model, ...dropUndefined(defaults.model) } as ModelSpec;
  if (defaults.permissions) {
    out.permissions = {
      ...(base.permissions ?? {}),
      ...dropUndefined(defaults.permissions),
    } as Permissions;
  }
  if (defaults.budget) {
    out.budget = {
      ...(base.budget ?? {}),
      ...dropUndefined(defaults.budget),
    } as Partial<Budget>;
  }
  if (defaults.sampling) {
    out.sampling = {
      ...(base.sampling ?? {}),
      ...dropUndefined(defaults.sampling),
    } as SamplingParams;
  }
  return out;
}

// ----------------------------------------------------------------------
// Built-in: chat
// ----------------------------------------------------------------------

function buildChatBuiltin(
  _cfg: HarnessConfig,
  entry: AgentEntryInput,
  defaults: AgentDefaults,
): AgentDefinition {
  if (entry.agent.kind !== "builtin") {
    throw new Error("buildChatBuiltin called with non-builtin agent block");
  }
  const opts: Parameters<typeof defineChatAgent>[0] = {
    name: entry.id,
    model: dropUndefined(defaults.model) as ModelSpec,
    systemPrompt: entry.agent.systemPrompt,
  };
  if (entry.mcpServers) opts.mcpServers = entry.mcpServers as McpServerConfig[];
  if (defaults.permissions) opts.permissions = dropUndefined(defaults.permissions) as Permissions;
  if (defaults.budget) opts.budget = dropUndefined(defaults.budget) as Partial<Budget>;
  if (defaults.sampling) opts.sampling = dropUndefined(defaults.sampling) as SamplingParams;
  return defineChatAgent(opts);
}

// ----------------------------------------------------------------------
// Pack contribution merger (per-agent)
// ----------------------------------------------------------------------

async function mergePackContributions(
  base: AgentDefinition,
  cfg: HarnessConfig,
  entry: AgentEntryInput,
  packs: LoadedPack[],
  env: NodeJS.ProcessEnv,
): Promise<AgentDefinition> {
  if (packs.length === 0 && !entry.mcpServers?.length) return base;

  const localTools: LocalToolHandler[] = [...(base.localTools ?? [])];
  const mcpServers: McpServerConfig[] = [...(base.mcpServers ?? [])];
  const skills: SkillMetadata[] = [];

  // Per-agent mcpServers from YAML — already merged into base by
  // `buildChatBuiltin` for builtin agents; merge here for custom agents.
  if (entry.agent.kind === "custom" && entry.mcpServers?.length) {
    for (const m of entry.mcpServers as McpServerConfig[]) {
      mcpServers.push(m);
    }
  }

  let baseSkills: SkillMetadata[] | undefined;
  if (base.skills?.kind === "explicit") baseSkills = base.skills.skills;

  // Pack ctx.entryName is bundle-wide — all agents share the same pack
  // namespace (e.g. cap-memory-pg's Postgres namespace = bundle name).
  for (const loaded of packs) {
    const ctx = makePackContext(loaded, cfg.name, env);
    await contributeFromPack(loaded.pack, ctx, { localTools, mcpServers, skills });
  }

  const out: AgentDefinition = {
    ...base,
    ...(localTools.length ? { localTools } : {}),
    ...(mcpServers.length ? { mcpServers } : {}),
    ...(packs.length ? { capabilityPacks: mergeCapabilityPacks(base.capabilityPacks, packs) } : {}),
  };

  const allSkills = [...(baseSkills ?? []), ...skills];
  if (allSkills.length) {
    out.skills = { kind: "explicit", skills: allSkills };
  } else if (base.skills && base.skills.kind === "directory") {
    out.skills = base.skills;
  }
  return out;
}

function mergeCapabilityPacks(existing: string[] | undefined, packs: LoadedPack[]): string[] {
  return [...new Set([...(existing ?? []), ...packs.map((loaded) => loaded.ref.pack)])];
}

interface ContribAccumulator {
  localTools: LocalToolHandler[];
  mcpServers: McpServerConfig[];
  skills: SkillMetadata[];
}

async function contributeFromPack(
  pack: CapabilityPack,
  ctx: PackContext,
  acc: ContribAccumulator,
): Promise<void> {
  if (pack.localTools) {
    const tools = await pack.localTools(ctx);
    for (const t of tools) {
      const namespaced: LocalToolHandler = {
        ...t,
        definition: {
          ...t.definition,
          name: namespacedToolName(pack.name, t.definition.name),
          source: `pack:${pack.name}`,
        },
      };
      acc.localTools.push(namespaced);
    }
  }
  if (pack.mcpServers) {
    const servers = await pack.mcpServers(ctx);
    for (const s of servers) {
      acc.mcpServers.push({
        ...s,
        name: namespacedMcpServerName(pack.name, s.name),
      });
    }
  }
  if (pack.skills) {
    const sks = await pack.skills(ctx);
    for (const sk of sks) acc.skills.push(sk);
  }
}

// ----------------------------------------------------------------------
// Selective env interpolation
// ----------------------------------------------------------------------

function interpolateEnvSlots(cfg: HarnessConfig, env: NodeJS.ProcessEnv): HarnessConfig {
  const lookup = (name: string): string | undefined => env[name];
  const out: HarnessConfig = { ...cfg };
  if (cfg.capabilities) {
    out.capabilities = cfg.capabilities.map(
      (ref): CapabilityRef =>
        ref.config
          ? {
              ...ref,
              config: interpolateTree(ref.config, lookup, {
                errorPrefix: `render-harness.yaml capabilities[${ref.pack}].config`,
              }),
            }
          : ref,
    );
  }
  out.agents = cfg.agents.map((a) =>
    a.mcpServers
      ? {
          ...a,
          mcpServers: interpolateTree(a.mcpServers, lookup, {
            errorPrefix: `render-harness.yaml agents[${a.id}].mcpServers`,
          }),
        }
      : a,
  );
  return out;
}
