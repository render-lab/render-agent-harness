/**
 * Add-agent planner + mutators.
 *
 * Mirror of `capability-install.ts`. The route in `routes/agent-add.ts`
 * reads `render-harness.yaml`, `package.json`, `.env.example`, and any
 * colliding `src/<id>.ts` from a managed repo, calls the planner +
 * mutators here, re-emits `render.yaml` via the registry's
 * `emitBlueprint`, and pushes everything back via the GitHub App.
 *
 * Catalog source: every gallery entry. Bundle entries contribute one
 * unit per agent in `agents[]`; single-agent entries (chat, support-bot,
 * research-cron, work-monitor, …) contribute one unit each. For agents
 * that reference a built-in (`agent.kind: builtin`), there's no source
 * file to write — only the manifest is mutated.
 */

import type {
  ResolvedAgentEntry,
  ResolvedCapabilityEntry,
  ResolvedGallery,
} from "@render-harness/registry/gallery";
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import { OFFICIAL_CAPABILITY_INSTALLS } from "./capability-install.js";

export interface AgentAddSource {
  /** Slug of the bundle gallery entry to extract the agent from. */
  bundleSlug: string;
  /** `agents[].id` inside that bundle. */
  agentId: string;
}

export interface AgentAddCapabilitySpec {
  pack: string;
  versionRange: string | null;
  envVars: string[];
}

export interface AgentAddEnvAddition {
  name: string;
  required: boolean;
  secret: boolean;
  description: string | null;
}

export interface AgentAddSpec {
  source: AgentAddSource;
  /** The `agents[]` entry to append, as a plain JSON object. */
  agentEntry: Record<string, unknown>;
  /**
   * Repo-relative path of the source file to write (e.g. `src/meeting-prep.ts`).
   * `null` when the agent references a builtin (`agent.kind: builtin`)
   * and therefore has no custom source to commit.
   */
  sourceFilePath: string | null;
  /** Source file contents from the bundle. `null` mirrors `sourceFilePath`. */
  sourceFileContent: string | null;
  /** Capability packs the bundle declares — added to target if not present. */
  capabilities: AgentAddCapabilitySpec[];
  /** envSchema entries the bundle declares — added to target if not present. */
  envSchemaAdditions: AgentAddEnvAddition[];
}

export interface AgentAddPlan {
  spec: AgentAddSpec;
  warnings: string[];
}

export class AgentAddError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentAddError";
  }
}

// ---------------------------------------------------------------------
// Catalog: derived view of the gallery
// ---------------------------------------------------------------------

export interface AddableAgent {
  bundleSlug: string;
  bundleName: string;
  agentId: string;
  description: string;
  runtimeKinds: string[];
  /** Capability packs the bundle declares. */
  capabilities: string[];
  /** envSchema names the bundle declares. */
  envVars: string[];
  workflowTask: boolean;
}

/**
 * Flatten the gallery into per-agent addable units. Both bundle and
 * single-agent entries contribute: bundles fan out across their
 * `agents[]`, single-agent entries contribute one unit each (one entry
 * = one agent).
 *
 * Field names retain `bundle*` prefixes for wire-compat with the
 * already-shipped client; semantically these are the gallery entry's
 * slug and display name.
 */
export function listAddableAgents(gallery: ResolvedGallery): AddableAgent[] {
  const out: AddableAgent[] = [];
  for (const entry of gallery.agents) {
    const agents = ((entry.manifest as { agents?: unknown[] }).agents ?? []) as Array<
      Record<string, unknown>
    >;
    for (const agent of agents) {
      const id = typeof agent.id === "string" ? agent.id : null;
      if (!id) continue;
      // Single-agent gallery entries (chat, support-bot, …) typically
      // don't put a description on the agent block — fall back to the
      // entry's description so the catalog card never says "no description".
      const agentDescription = typeof agent.description === "string" ? agent.description : "";
      const description = agentDescription || entry.description;
      const runtimes = Array.isArray(agent.runtimes)
        ? (agent.runtimes as Array<Record<string, unknown>>)
            .map((rt) => (typeof rt.kind === "string" ? rt.kind : null))
            .filter((v): v is string => Boolean(v))
        : [];
      out.push({
        bundleSlug: entry.slug,
        bundleName: entry.name,
        agentId: id,
        description,
        runtimeKinds: runtimes,
        capabilities: entry.capabilities,
        envVars: bundleEnvVarNames(entry),
        workflowTask: isWorkflowTask(agent),
      });
    }
  }
  return out;
}

function bundleEnvVarNames(entry: ResolvedAgentEntry): string[] {
  const env = (entry.manifest as { envSchema?: unknown[] }).envSchema;
  if (!Array.isArray(env)) return [];
  const out: string[] = [];
  for (const item of env) {
    if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      out.push((item as { name: string }).name);
    }
  }
  return out;
}

function isWorkflowTask(agent: Record<string, unknown>): boolean {
  if (agent.workflowTask === true) return true;
  const runtimes = Array.isArray(agent.runtimes)
    ? (agent.runtimes as Array<Record<string, unknown>>)
    : [];
  for (const rt of runtimes) {
    if (rt.kind === "workflows") return true;
    if (rt.kind === "cron" && rt.via === "workflow") return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------

export interface PlanAgentAddArgs {
  gallery: ResolvedGallery;
  source: AgentAddSource;
  /** Current `render-harness.yaml` content of the target repo. */
  manifestText: string;
  /**
   * Current contents of `src/<id>.ts` in the target repo, or null if
   * the file doesn't exist. Used to enforce no-clobber on collision.
   */
  existingSourceFileText: string | null;
}

export function planAgentAdd(args: PlanAgentAddArgs): AgentAddPlan {
  const entry = args.gallery.agents.find((a) => a.slug === args.source.bundleSlug);
  if (!entry) {
    throw new AgentAddError(
      "bundle_not_found",
      `gallery entry "${args.source.bundleSlug}" not in gallery`,
    );
  }

  const bundleAgents = ((entry.manifest as { agents?: unknown[] }).agents ?? []) as Array<
    Record<string, unknown>
  >;
  const bundleAgent = bundleAgents.find(
    (a) => typeof a.id === "string" && a.id === args.source.agentId,
  );
  if (!bundleAgent) {
    throw new AgentAddError(
      "agent_not_found_in_bundle",
      `agent "${args.source.agentId}" not in gallery entry "${args.source.bundleSlug}"`,
    );
  }

  // Only `kind: custom` agents have a source file to commit. `kind: builtin`
  // references a builtin shipped by @render-harness/registry; only the
  // manifest entry needs to land in the target repo.
  const entrypointRaw =
    bundleAgent.agent &&
    typeof bundleAgent.agent === "object" &&
    typeof (bundleAgent.agent as { entrypoint?: unknown }).entrypoint === "string"
      ? (bundleAgent.agent as { entrypoint: string }).entrypoint
      : null;
  let sourceFilePath: string | null = null;
  let sourceFileContent: string | null = null;
  if (entrypointRaw) {
    sourceFilePath = normalizeEntrypoint(entrypointRaw);
    const content = entry.sourceFiles[sourceFilePath];
    if (content === undefined) {
      throw new AgentAddError(
        "source_file_missing_in_gallery",
        `gallery entry "${args.source.bundleSlug}" has no source file at ${sourceFilePath}`,
      );
    }
    sourceFileContent = content;
  }

  // Parse the target manifest. Collisions surface here.
  const doc = parseDocument(args.manifestText);
  if (doc.errors.length > 0) {
    throw new AgentAddError(
      "invalid_manifest",
      `render-harness.yaml parse errors: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const warnings: string[] = [];

  const agentsSeq = doc.get("agents", true);
  if (isSeq(agentsSeq)) {
    if (findAgent(agentsSeq, args.source.agentId)) {
      throw new AgentAddError(
        "agent_id_exists",
        `agents[].id "${args.source.agentId}" already present in target manifest`,
      );
    }
  }

  if (sourceFilePath && sourceFileContent !== null) {
    if (args.existingSourceFileText !== null && args.existingSourceFileText !== sourceFileContent) {
      throw new AgentAddError(
        "source_file_conflict",
        `${sourceFilePath} already exists in target repo with different content`,
      );
    }
    if (args.existingSourceFileText === sourceFileContent) {
      warnings.push(`${sourceFilePath} already present with identical content; not rewriting.`);
    }
  }

  const capabilities = resolveCapabilities(entry.capabilities, args.gallery.capabilities);
  const envSchemaAdditions = readEnvSchema(entry);

  return {
    spec: {
      source: args.source,
      agentEntry: bundleAgent,
      sourceFilePath,
      sourceFileContent,
      capabilities,
      envSchemaAdditions,
    },
    warnings,
  };
}

function normalizeEntrypoint(raw: string): string {
  let rel = raw.replace(/^\.\//, "");
  rel = rel.replace(/^\/+/, "");
  return rel;
}

function resolveCapabilities(
  packs: string[],
  resolvedCaps: ResolvedCapabilityEntry[],
): AgentAddCapabilitySpec[] {
  return packs.map((pack) => {
    const official = OFFICIAL_CAPABILITY_INSTALLS[pack];
    if (official) {
      return { pack, versionRange: official.versionRange, envVars: official.envVars };
    }
    const resolved = resolvedCaps.find((c) => c.pack === pack);
    return {
      pack,
      versionRange: resolved?.versionRange ?? null,
      envVars: resolved?.envHint ? [resolved.envHint] : [],
    };
  });
}

function readEnvSchema(entry: ResolvedAgentEntry): AgentAddEnvAddition[] {
  const env = (entry.manifest as { envSchema?: unknown[] }).envSchema;
  if (!Array.isArray(env)) return [];
  const out: AgentAddEnvAddition[] = [];
  for (const item of env) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string") continue;
    out.push({
      name: rec.name,
      required: rec.required === true,
      secret: rec.secret === true,
      description: typeof rec.description === "string" ? rec.description : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------

/**
 * Append the new agent to `agents[]`, dedupe-merge `capabilities[]`,
 * and dedupe-merge `envSchema[]`. Preserves comments + key order via
 * the `yaml` Document AST.
 */
export function mutateManifestForAgentAdd(args: { yamlText: string; plan: AgentAddPlan }): string {
  const doc = parseDocument(args.yamlText);
  if (doc.errors.length > 0) {
    throw new AgentAddError(
      "invalid_manifest",
      `render-harness.yaml parse errors: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const agentsSeq = ensureSeq(doc, "agents");
  agentsSeq.add(doc.createNode(args.plan.spec.agentEntry));

  if (args.plan.spec.capabilities.length > 0) {
    const capsSeq = ensureSeq(doc, "capabilities");
    for (const cap of args.plan.spec.capabilities) {
      if (!findCapability(capsSeq, cap.pack)) {
        capsSeq.add(doc.createNode({ pack: cap.pack }));
      }
    }
  }

  if (args.plan.spec.envSchemaAdditions.length > 0) {
    const envSeq = ensureSeq(doc, "envSchema");
    const existing = new Set(
      envSeq.items
        .map((item) => (isMap(item) ? readScalar(item.get("name")) : null))
        .filter((v): v is string => Boolean(v)),
    );
    for (const env of args.plan.spec.envSchemaAdditions) {
      if (existing.has(env.name)) continue;
      const obj: Record<string, unknown> = { name: env.name };
      if (env.required) obj.required = true;
      if (env.secret) obj.secret = true;
      if (env.description) obj.description = env.description;
      envSeq.add(doc.createNode(obj));
    }
  }

  return doc.toString();
}

/**
 * Add capability packs to `dependencies`. Pure JSON edit; preserves
 * existing field order via JSON.stringify on the original object.
 */
export function mutatePackageJsonAddDeps(args: {
  jsonText: string;
  capabilities: AgentAddCapabilitySpec[];
}): string {
  if (args.capabilities.length === 0) return args.jsonText;
  const pkg = JSON.parse(args.jsonText) as { dependencies?: Record<string, string> };
  const deps = { ...(pkg.dependencies ?? {}) };
  let changed = false;
  for (const cap of args.capabilities) {
    if (deps[cap.pack]) continue;
    deps[cap.pack] = cap.versionRange ?? "*";
    changed = true;
  }
  if (!changed) return args.jsonText;
  pkg.dependencies = deps;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Append any new env var names to `.env.example` under an "Added
 * agent: <id>" header. Skips names already present.
 */
export function mutateEnvExampleForAgent(args: {
  text: string;
  agentId: string;
  envVars: string[];
}): string {
  if (args.envVars.length === 0) return args.text;
  const base = args.text.endsWith("\n") ? args.text : `${args.text}\n`;
  const missing = args.envVars.filter(
    (name) => !new RegExp(`^${escapeRegex(name)}=`, "m").test(base),
  );
  if (missing.length === 0) return base;
  let out = base;
  out += `\n# Added agent: ${args.agentId}\n`;
  for (const name of missing) out += `${name}=\n`;
  return out;
}

// ---------------------------------------------------------------------
// YAML AST helpers (shared with capability-install.ts via copy; hoist
// to yaml-helpers.ts if a third consumer appears)
// ---------------------------------------------------------------------

function ensureSeq(doc: ReturnType<typeof parseDocument>, key: string): YAMLSeq {
  let seq = doc.get(key, true);
  if (!seq) {
    seq = doc.createNode([]);
    doc.set(key, seq);
  }
  if (!isSeq(seq)) {
    throw new AgentAddError("invalid_manifest", `${key} must be a sequence`);
  }
  return seq;
}

function findAgent(agents: YAMLSeq, agentId: string): YAMLMap | null {
  for (const item of agents.items) {
    if (isMap(item) && readScalar(item.get("id")) === agentId) return item;
  }
  return null;
}

function findCapability(capabilities: YAMLSeq, pack: string): YAMLMap | null {
  for (const item of capabilities.items) {
    if (isMap(item) && readScalar(item.get("pack")) === pack) return item;
  }
  return null;
}

function readScalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
