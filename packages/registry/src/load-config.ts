/**
 * The runtime entry point for YAML-driven harness entries.
 *
 * Reads `render-harness.yaml`, resolves the agent (built-in or custom
 * entrypoint), loads any capability packs from the entry's
 * `node_modules`, and assembles a runnable {@link AgentDefinition}.
 *
 * Entries import this and call it from their `agent/index.ts`:
 *
 *   import { defineFromConfig } from "@render-harness/registry";
 *   export const agent = await defineFromConfig({
 *     configPath: "./render-harness.yaml",
 *     env: process.env,
 *   });
 *
 * Then their runtime entrypoint (main.ts) passes that AgentDefinition
 * to the matching `runCron` / `serveAgent` / `startWorker` /
 * Workflows handler.
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AgentDefinition,
  type Budget,
  type LocalToolHandler,
  type McpServerConfig,
  type ModelSpec,
  type Permissions,
  type SamplingParams,
  type SkillMetadata,
  defineAgent,
} from "@render-harness/core";
import { defineChatAgent } from "./builtin-chat.js";
import {
  type CapabilityPack,
  type PackContext,
  namespacedMcpServerName,
  namespacedToolName,
} from "./capability.js";
import { interpolateTree } from "./interpolate.js";
import {
  type CapabilityRef,
  type HarnessConfig,
  parseHarnessConfigYaml,
} from "./schema.js";
import { type LoadedPack, loadPacks, makePackContext } from "./load-pack.js";
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
  agent: AgentDefinition;
  config: HarnessConfig;
  packs: LoadedPack[];
}

/**
 * Resolve a render-harness.yaml into a complete {@link AgentDefinition}.
 *
 * The returned `agent` is ready to pass straight to a runtime
 * (`runCron`, `serveAgent`, `startWorker`, or the Workflows step
 * handler). The `config` and `packs` fields are exposed for advanced
 * callers that want to inspect what was loaded — e.g. emitting a
 * Render service spec at build time.
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
  // Resolve ${VAR} placeholders in MCP headers, env values, etc. We
  // don't interpolate over the system prompt so authors can keep
  // literal `${}` in their prose without escaping.
  const config = interpolateConfigEnvSlots(rawConfig, env);

  const packs = await loadPacks(
    config.capabilities ? { entryRoot, refs: config.capabilities } : { entryRoot },
  );

  const baseAgent = await resolveAgentBlock(config, entryRoot);

  // Merge pack contributions on top of whatever the agent block
  // produced. Pack-contributed tools / MCP servers / skills come in
  // namespaced; deniedTools / requireApproval references must use the
  // namespaced names if they target pack tools.
  const merged = await mergePackContributions(baseAgent, config, packs, env);

  // Re-validate via defineAgent so we get the same checks the regular
  // TS path runs (e.g. requireApproval ∩ deniedTools = ∅).
  const agent = defineAgent(merged);

  return { agent, config, packs };
}

// ----------------------------------------------------------------------
// Agent block resolver
// ----------------------------------------------------------------------

async function resolveAgentBlock(
  config: HarnessConfig,
  entryRoot: string,
): Promise<AgentDefinition> {
  if (config.agent.kind === "builtin") {
    return buildChatBuiltin(config);
  }
  // kind: custom — dynamic-import the entrypoint and trust the export.
  const entrypointAbs = resolve(entryRoot, config.agent.entrypoint);
  const entryUrl = pathToFileURL(entrypointAbs).href;
  const mod = (await import(entryUrl)) as Record<string, unknown>;
  const exported = mod.default ?? mod.agent;
  if (!exported) {
    throw new Error(
      `agent.entrypoint "${config.agent.entrypoint}" does not export a default or named "agent" value`,
    );
  }
  // Either an AgentDefinition or a factory. Call factories.
  const candidate = typeof exported === "function" ? await (exported as () => unknown)() : exported;
  if (!isAgentDefinitionShape(candidate)) {
    throw new Error(
      `agent.entrypoint "${config.agent.entrypoint}": export is not an AgentDefinition`,
    );
  }
  // Override the top-level fields the YAML wants to control even when
  // the agent is custom. Authors who want full control should put
  // these in their TS code instead of YAML, but it'd be very surprising
  // if `model:` in YAML were silently ignored.
  return overlayYamlFields(candidate, config);
}

function isAgentDefinitionShape(v: unknown): v is AgentDefinition {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.systemPrompt === "string";
}

function overlayYamlFields(base: AgentDefinition, config: HarnessConfig): AgentDefinition {
  // Only overlay fields the YAML actually declared. The `agent` block
  // for custom agents has no system prompt, so we never overwrite it.
  // dropUndefined() is needed because Zod's inferred optional fields
  // are `T | undefined`, but core's types are strict-optional.
  const out: AgentDefinition = { ...base };
  out.model = { ...base.model, ...dropUndefined(config.model) } as ModelSpec;
  if (config.permissions) {
    out.permissions = {
      ...(base.permissions ?? {}),
      ...dropUndefined(config.permissions),
    } as Permissions;
  }
  if (config.budget) {
    out.budget = {
      ...(base.budget ?? {}),
      ...dropUndefined(config.budget),
    } as Partial<Budget>;
  }
  if (config.sampling) {
    out.sampling = {
      ...(base.sampling ?? {}),
      ...dropUndefined(config.sampling),
    } as SamplingParams;
  }
  return out;
}

// ----------------------------------------------------------------------
// Built-in: chat
//
// The simplest viable agent: system prompt + model + (optional) MCP
// servers. No local tools, no skills directory. Lives here rather than
// in @render-harness/core because it's a YAML-side convenience, not a
// core primitive.
// ----------------------------------------------------------------------

function buildChatBuiltin(config: HarnessConfig): AgentDefinition {
  if (config.agent.kind !== "builtin") {
    throw new Error("buildChatBuiltin called with non-builtin agent block");
  }
  const opts: Parameters<typeof defineChatAgent>[0] = {
    name: config.name,
    model: dropUndefined(config.model) as ModelSpec,
    systemPrompt: config.agent.systemPrompt,
  };
  if (config.mcpServers) opts.mcpServers = config.mcpServers as McpServerConfig[];
  if (config.permissions) opts.permissions = dropUndefined(config.permissions) as Permissions;
  if (config.budget) opts.budget = dropUndefined(config.budget) as Partial<Budget>;
  if (config.sampling) opts.sampling = dropUndefined(config.sampling) as SamplingParams;
  return defineChatAgent(opts);
}

// ----------------------------------------------------------------------
// Pack contribution merger
// ----------------------------------------------------------------------

async function mergePackContributions(
  base: AgentDefinition,
  config: HarnessConfig,
  packs: LoadedPack[],
  env: NodeJS.ProcessEnv,
): Promise<AgentDefinition> {
  if (packs.length === 0 && !config.mcpServers?.length) return base;

  const localTools: LocalToolHandler[] = [...(base.localTools ?? [])];
  const mcpServers: McpServerConfig[] = [...(base.mcpServers ?? [])];
  const skills: SkillMetadata[] = [];

  // Top-level mcpServers from YAML (already merged into base when the
  // agent is builtin; for custom we add them here).
  if (config.agent.kind === "custom" && config.mcpServers?.length) {
    for (const m of config.mcpServers as McpServerConfig[]) {
      mcpServers.push(m);
    }
  }

  // Explicit pack-declared skills go into a one-shot `explicit` skills
  // block. If the base agent already had a skills directory, we keep
  // it and append: that requires switching to `explicit` + materialized
  // metadata, which is fine because pack-contributed skills already
  // come as SkillMetadata.
  let baseSkills: SkillMetadata[] | undefined;
  if (base.skills?.kind === "explicit") baseSkills = base.skills.skills;

  for (const loaded of packs) {
    const ctx = makePackContext(loaded, config.name, env);
    await contributeFromPack(loaded.pack, ctx, { localTools, mcpServers, skills });
  }

  const out: AgentDefinition = {
    ...base,
    ...(localTools.length ? { localTools } : {}),
    ...(mcpServers.length ? { mcpServers } : {}),
  };

  const allSkills = [...(baseSkills ?? []), ...skills];
  if (allSkills.length) {
    out.skills = { kind: "explicit", skills: allSkills };
  } else if (base.skills && base.skills.kind === "directory") {
    out.skills = base.skills;
  }
  return out;
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
      // Namespace the tool name so multiple packs can coexist.
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
//
// We only interpolate ${VAR} into fields where it semantically makes
// sense (MCP server headers/env/url, capability pack config). The
// system prompt and skills bodies are left alone.
// ----------------------------------------------------------------------

function interpolateConfigEnvSlots(config: HarnessConfig, env: NodeJS.ProcessEnv): HarnessConfig {
  const lookup = (name: string): string | undefined => env[name];
  const interpolated: HarnessConfig = { ...config };
  if (config.mcpServers) {
    interpolated.mcpServers = interpolateTree(config.mcpServers, lookup, {
      errorPrefix: "render-harness.yaml mcpServers",
    });
  }
  if (config.capabilities) {
    interpolated.capabilities = config.capabilities.map(
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
  return interpolated;
}
