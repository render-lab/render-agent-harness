/**
 * The CapabilityPack contract.
 *
 * A capability pack is an npm package whose default export is a
 * {@link CapabilityPack}. Packs contribute four kinds of things to an
 * entry:
 *
 *   1. `localTools` — TypeScript tool handlers merged into the
 *      AgentDefinition at boot time. Tool names are namespaced as
 *      `<pack>.<tool>` to avoid collisions when two packs contribute
 *      tools with the same short name.
 *
 *   2. `mcpServers` — extra MCP servers wired up at boot. Server names
 *      are namespaced as `<pack>.<server>`.
 *
 *   3. `skills` — skill metadata surfaced in the system prompt's skills
 *      index and loadable via the built-in `load_skill` tool.
 *
 *   4. `renderServices` — additional Render services merged into the
 *      generated render.yaml at build time (e.g. a sidecar pserv for a
 *      browser pool). Authors run `render-harness-build` once and commit
 *      the result.
 *
 * Plus an `envSchema` field that lists the env vars the pack needs.
 * These get merged into the entry's effective envSchema at build time
 * and surfaced in the README's Deploy-to-Render badge.
 *
 * Packs are loaded from the entry's own `node_modules` — they are
 * regular npm deps installed via `pnpm add`. The runtime library and
 * the build bin both walk the `capabilities[]` array in
 * render-harness.yaml, dynamic-import each pack, and validate the
 * default export against {@link CapabilityPackSchema}.
 */

import { z } from "zod";
import type {
  LocalToolHandler,
  McpServerConfig,
  SkillMetadata,
} from "@render-harness/core";
import { EnvVarSpecSchema, type EnvVarSpec } from "./schema.js";

// ----------------------------------------------------------------------
// Render service contributions
//
// Capability packs that need their own infrastructure (e.g. a browser
// pool sidecar) declare it via `renderServices`. The Blueprint emitter
// merges these into the entry's render.yaml. We deliberately use a
// narrow shape that matches the Render Blueprint schema; we don't try
// to model every Render service field.
// ----------------------------------------------------------------------

const RenderEnvVarSchema = z
  .object({
    key: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .max(64),
    value: z.string().optional(),
    sync: z.literal(false).optional(),
    fromService: z
      .object({
        name: z.string(),
        type: z.enum(["web", "pserv", "worker", "cron", "keyvalue"]),
        property: z.enum(["host", "port", "hostport", "connectionString"]),
        envVarKey: z.string().optional(),
      })
      .strict()
      .optional(),
    fromDatabase: z
      .object({
        name: z.string(),
        property: z.enum(["connectionString", "user", "password", "host", "port", "database"]),
      })
      .strict()
      .optional(),
    fromGroup: z.string().optional(),
  })
  .strict();

export const RenderServiceSpecSchema = z
  .object({
    type: z.enum(["pserv", "worker"]),
    name: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    runtime: z.enum(["node", "docker"]),
    region: z.string().min(1).max(32).optional(),
    plan: z.string().min(1).max(32).optional(),
    rootDir: z.string().optional(),
    buildCommand: z.string().optional(),
    startCommand: z.string().min(1).optional(),
    dockerfilePath: z.string().optional(),
    dockerContext: z.string().optional(),
    envVars: z.array(RenderEnvVarSchema).optional(),
  })
  .strict();

export type RenderServiceSpec = z.infer<typeof RenderServiceSpecSchema>;

// ----------------------------------------------------------------------
// Pack context
//
// Packs receive the user-supplied `config:` block and a tiny env
// resolver. The env resolver hides the difference between "the pack is
// being loaded at build time (process.env)" and "the pack is being
// loaded inside the running container at runtime (process.env again,
// but with secrets injected by Render)" — same shape, same behavior.
// ----------------------------------------------------------------------

export interface PackContext {
  /** User-supplied `config:` block from render-harness.yaml. */
  config: Record<string, unknown>;
  /** Resolve an env var by name. Returns undefined if unset. */
  env: (name: string) => string | undefined;
  /** The slug from render-harness.yaml's `name`. Useful for namespacing. */
  entryName: string;
}

// ----------------------------------------------------------------------
// Pack contract
// ----------------------------------------------------------------------

/**
 * A capability pack. Default-exported by every npm package that wants
 * to plug into render-harness entries.
 */
export interface CapabilityPack {
  /** Short, stable name. Used to namespace tools, MCP servers, skills. */
  name: string;
  /** Free-form version string; not validated by the loader. */
  version: string;
  /**
   * Env vars the pack consumes. Surfaced to the user at deploy time
   * and merged into the entry's effective envSchema by the Blueprint
   * emitter.
   */
  envSchema?: EnvVarSpec[];
  /** TS tool handlers contributed at runtime. */
  localTools?: (ctx: PackContext) => LocalToolHandler[] | Promise<LocalToolHandler[]>;
  /** MCP servers contributed at runtime. */
  mcpServers?: (ctx: PackContext) => McpServerConfig[] | Promise<McpServerConfig[]>;
  /** Skill metadata contributed at runtime. */
  skills?: (ctx: PackContext) => SkillMetadata[] | Promise<SkillMetadata[]>;
  /**
   * Extra Render services to merge into the generated render.yaml.
   * Called at build time only — the runtime library never invokes this.
   */
  renderServices?: (ctx: PackContext) => RenderServiceSpec[] | Promise<RenderServiceSpec[]>;
}

/**
 * Identity helper. Authors of capability packs default-export the
 * result of `definePack(...)` so they get IDE autocomplete and a
 * single import surface.
 */
export function definePack(pack: CapabilityPack): CapabilityPack {
  if (!pack.name || !/^[a-z0-9][a-z0-9-]*$/.test(pack.name)) {
    throw new Error(`definePack: name "${pack.name}" must match [a-z0-9][a-z0-9-]*`);
  }
  if (!pack.version) throw new Error("definePack: version is required");
  return pack;
}

// ----------------------------------------------------------------------
// Runtime validation of a loaded module's default export
// ----------------------------------------------------------------------

const PackShapeSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.string().min(1),
    envSchema: z.array(EnvVarSpecSchema).optional(),
    localTools: z.unknown().optional(),
    mcpServers: z.unknown().optional(),
    skills: z.unknown().optional(),
    renderServices: z.unknown().optional(),
  })
  .passthrough();

/**
 * Validate that a value loaded from a pack's default export looks like
 * a {@link CapabilityPack}. Returns the value cast to the right type;
 * throws `ZodError` on failure.
 */
export function assertCapabilityPack(value: unknown, packageName: string): CapabilityPack {
  const result = PackShapeSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `capability pack "${packageName}": default export is not a valid CapabilityPack: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  // The function fields are typed as `unknown` in the Zod schema because
  // we can't reasonably validate function signatures at runtime; cast
  // back to the typed shape after the structural check.
  return value as CapabilityPack;
}

// ----------------------------------------------------------------------
// Naming helpers
// ----------------------------------------------------------------------

/**
 * Namespace a short tool name with the pack's name. `cap-search-exa` +
 * `web_search` → `cap-search-exa.web_search`.
 */
export function namespacedToolName(packName: string, toolName: string): string {
  return `${packName}.${toolName}`;
}

/**
 * Namespace a short MCP server name with the pack's name.
 */
export function namespacedMcpServerName(packName: string, serverName: string): string {
  return `${packName}.${serverName}`;
}
