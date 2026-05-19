/**
 * Surgical edits to a `render-harness.yaml` source string. Uses the
 * `yaml` package's `Document` AST so comments, key order, and
 * unrelated fields are preserved across the round-trip.
 *
 * Today:
 *   - Setting an agent's `model:` block via {@link mutateAgentModel}.
 *     Backs `PATCH /agents/:slug/model`.
 *   - Replacing an agent's `agent.systemPrompt` (builtin chat agents
 *     only) via {@link mutateAgentSystemPrompt}. Backs
 *     `PATCH /agents/:slug/system-prompt`.
 *
 * Always writes per-agent overrides under `agents[i]`, even when a
 * `shared.*` value already covers the picked spec. This is deterministic
 * — one code path regardless of how the YAML happens to be structured —
 * and matches `effectiveAgentDefaults()` precedence in
 * `@render-harness/registry/load-config.ts`.
 */

import { isMap, isSeq, parseDocument, Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import type { ModelSpecInput } from "../schema.js";

export interface MutateAgentModelOpts {
  yamlText: string;
  agentId: string;
  spec: ModelSpecInput;
}

export interface MutateAgentSystemPromptOpts {
  yamlText: string;
  agentId: string;
  systemPrompt: string;
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`agent "${agentId}" not found under agents[]`);
    this.name = "AgentNotFoundError";
  }
}

export class InvalidManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidManifestError";
  }
}

/**
 * Raised by {@link mutateAgentSystemPrompt} when the matched agent's
 * `agent.kind` is not `builtin`. Custom (TS-entrypoint) agents define
 * their system prompt in source code, not YAML, so they're not editable
 * via this path — the route translates this into a 409.
 */
export class AgentNotEditableError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly entrypoint: string | null,
  ) {
    const where = entrypoint ? ` (defined in ${entrypoint})` : "";
    super(
      `agent "${agentId}" uses a custom entrypoint${where}; its system prompt lives in TypeScript source, not render-harness.yaml`,
    );
    this.name = "AgentNotEditableError";
  }
}

/**
 * Return a new YAML string with `agents[*].model` replaced for the
 * matching `agentId`. Throws if the document doesn't have an `agents:`
 * sequence or the agent id can't be found.
 */
export function mutateAgentModel(opts: MutateAgentModelOpts): string {
  const doc = parseDocument(opts.yamlText);
  if (doc.errors.length > 0) {
    throw new InvalidManifestError(
      `render-harness.yaml has parse errors: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const agents = doc.get("agents", true);
  if (!isSeq(agents)) {
    throw new InvalidManifestError("manifest must have an `agents:` sequence");
  }

  const index = findAgentIndex(agents, opts.agentId);
  if (index === -1) throw new AgentNotFoundError(opts.agentId);

  // Build the new model node from the canonical spec. Building from a
  // plain object lets us preserve only the fields the spec actually
  // sets — going from openai-compat back to anthropic removes the old
  // baseURL/apiKeyEnv keys without us having to delete them by hand.
  const modelNode = doc.createNode(specToPlainObject(opts.spec));
  doc.setIn(["agents", index, "model"], modelNode);

  return doc.toString();
}

function findAgentIndex(seq: YAMLSeq, agentId: string): number {
  const items = seq.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isMap<unknown, unknown>(item)) continue;
    const id = readScalar((item as YAMLMap).get("id"));
    if (id === agentId) return i;
  }
  return -1;
}

/**
 * Return a new YAML string with `agents[*].agent.systemPrompt` replaced
 * for the matching `agentId`. Throws:
 *
 *  - {@link InvalidManifestError} if the document is malformed or
 *    missing an `agents:` sequence.
 *  - {@link AgentNotFoundError} if the agent id can't be matched.
 *  - {@link AgentNotEditableError} if the matched agent's `agent.kind`
 *    is not `"builtin"`. Custom (TS-entrypoint) agents store their
 *    system prompt in source, not YAML; the operator UI surfaces a
 *    read-only preview and a pointer to the file instead of an edit
 *    form for those.
 *
 * Multi-line prompts are emitted as `|` block scalars so the on-disk
 * YAML stays human-readable; single-line prompts use the default
 * inline scalar.
 */
export function mutateAgentSystemPrompt(opts: MutateAgentSystemPromptOpts): string {
  const doc = parseDocument(opts.yamlText);
  if (doc.errors.length > 0) {
    throw new InvalidManifestError(
      `render-harness.yaml has parse errors: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const agents = doc.get("agents", true);
  if (!isSeq(agents)) {
    throw new InvalidManifestError("manifest must have an `agents:` sequence");
  }

  const index = findAgentIndex(agents, opts.agentId);
  if (index === -1) throw new AgentNotFoundError(opts.agentId);

  const agentEntry = (agents as YAMLSeq).items[index];
  if (!isMap<unknown, unknown>(agentEntry)) {
    throw new InvalidManifestError(`agents[${index}] is not a map`);
  }
  const agentBlock = (agentEntry as YAMLMap).get("agent", true);
  if (!agentBlock || !isMap<unknown, unknown>(agentBlock)) {
    throw new InvalidManifestError(`agents[${index}].agent is missing or not a map`);
  }
  const kind = readScalar((agentBlock as YAMLMap).get("kind"));
  if (kind !== "builtin") {
    const entrypoint = readScalar((agentBlock as YAMLMap).get("entrypoint"));
    throw new AgentNotEditableError(opts.agentId, entrypoint);
  }

  const promptScalar = new Scalar(opts.systemPrompt);
  // Block-scalar form keeps multi-line prompts readable on disk. The
  // single-line case stays flow-style ("systemPrompt: hello") to match
  // the scaffolder's default output.
  if (opts.systemPrompt.includes("\n")) {
    promptScalar.type = Scalar.BLOCK_LITERAL;
  }
  doc.setIn(["agents", index, "agent", "systemPrompt"], promptScalar);

  return doc.toString();
}

function readScalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

/**
 * Strip undefined / empty optional fields. `yaml.createNode` emits
 * keys verbatim from the input object, so we filter at this layer to
 * keep the on-disk YAML tidy.
 */
function specToPlainObject(spec: ModelSpecInput): Record<string, unknown> {
  const out: Record<string, unknown> = { provider: spec.provider, model: spec.model };
  if (spec.baseURL) out.baseURL = spec.baseURL;
  if (spec.apiKeyEnv) out.apiKeyEnv = spec.apiKeyEnv;
  if (spec.thinking) out.thinking = { ...spec.thinking };
  return out;
}
